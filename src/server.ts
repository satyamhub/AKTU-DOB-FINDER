import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import session from 'express-session';
import { runDobSearch } from './runner';
import { PlaywrightService } from './scraping/playwright.service';
import { DatabaseService } from './database/database.service';
import { SearchHistory } from './interfaces';

const USE_PLAYWRIGHT = process.env.USE_PLAYWRIGHT === '1';
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me';

const addOneDay = (day: number, month: number, year: number): { day: number; month: number; year: number } | null => {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + 1);
  return { day: date.getDate(), month: date.getMonth() + 1, year: date.getFullYear() };
};

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true }
});
app.use(sessionMiddleware);

const isAuthenticated = (req: express.Request): boolean => {
  return Boolean((req.session as any)?.user);
};

app.get('/login', (req, res) => {
  if (isAuthenticated(req)) {
    res.redirect('/');
    return;
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    (req.session as any).user = { username };
    res.redirect('/');
    return;
  }
  res.status(401).send('Invalid credentials');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.use((req, res, next) => {
  if (req.path === '/login') return next();
  if (req.path === '/logout') return next();
  if (req.path.startsWith('/socket.io')) return next();
  if (isAuthenticated(req)) return next();
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

// NOTE: Socket auth disabled temporarily to avoid session-cookie issues on refresh.
// const wrap = (middleware: any) => (socket: any, next: any) =>
//   middleware(socket.request, {} as any, next);
// io.use(wrap(sessionMiddleware));
// io.use((socket, next) => {
//   const req = socket.request as any;
//   if (req?.session?.user) return next();
//   next(new Error('Unauthorized'));
// });

type UserState = {
  running: boolean;
  cancelRequested: boolean;
  logs: string[];
  lastProgress?: { day: number; month: number; year: number; attempts: number; total: number };
  sockets: Set<any>;
};

const globalState: UserState = {
  running: false,
  cancelRequested: false,
  logs: [],
  sockets: new Set()
};

io.on('connection', (socket) => {
  const reqAny = socket.request as any;
  globalState.sockets.add(socket);

  socket.emit('status', { running: globalState.running });
  if (globalState.logs.length) {
    socket.emit('logs', globalState.logs);
  }
  if (globalState.lastProgress) {
    socket.emit('progress', globalState.lastProgress);
  }
  const sendHistory = async () => {
    const history = await DatabaseService.listSearchHistory(50);
    const safeHistory = history.map((h: any) => ({
      ...h,
      id: h._id?.toString?.() || String(h._id)
    }));
    socket.emit('history', safeHistory);
  };

  sendHistory().catch((err) => socket.emit('error', err instanceof Error ? err.message : String(err)));

  socket.on('start', async (payload) => {
    if (globalState.running) {
      socket.emit('error', 'A run is already in progress.');
      return;
    }

    const rollNumber = String(payload?.rollNumber || '').trim();
    const startYear = Number(payload?.startYear);
    const endYear = Number(payload?.endYear);
    const startMonth = Number(payload?.startMonth);
    const endMonth = Number(payload?.endMonth);
    const concurrency = Number(payload?.concurrency ?? 2);

    if (
      !rollNumber ||
      !Number.isFinite(startYear) ||
      !Number.isFinite(endYear) ||
      !Number.isFinite(startMonth) ||
      !Number.isFinite(endMonth)
    ) {
      socket.emit('error', 'Please provide roll number, start/end year, and start/end month.');
      return;
    }

    const safeConcurrency = Math.max(1, Math.min(concurrency, 3));

    globalState.running = true;
    globalState.cancelRequested = false;
    globalState.sockets.forEach((s) => s.emit('status', { running: true }));

    const log = (message: string) => {
      globalState.logs.push(message);
      if (globalState.logs.length > 500) globalState.logs.shift();
      globalState.sockets.forEach((s) => s.emit('log', message));
    };
    const isCancelled = () => globalState.cancelRequested;
    let lastAttempts = 0;
    let lastProgress: { day: number; month: number; year: number } | undefined;
    const progress = (p: { attempts: number; total: number; day: number; month: number; year: number }) => {
      lastAttempts = p.attempts;
      lastProgress = { day: p.day, month: p.month, year: p.year };
      globalState.lastProgress = { ...p };
      globalState.sockets.forEach((s) => s.emit('progress', p));
    };

    const historyRecord: SearchHistory = {
      rollNumber,
      startYear,
      endYear,
      startMonth,
      endMonth,
      usePlaywright: USE_PLAYWRIGHT,
      status: 'running',
      startedAt: new Date()
    };

    try {
      log(`Starting search for ${rollNumber} (${startYear}-${endYear})`);
      const result = await runDobSearch(
        { rollNumber, startYear, endYear, startMonth, endMonth, concurrency: safeConcurrency, usePlaywright: USE_PLAYWRIGHT },
        log,
        isCancelled,
        progress
      );
      if (globalState.cancelRequested) {
        historyRecord.status = 'cancelled';
      } else if (result) {
        historyRecord.status = 'found';
        historyRecord.result = {
          name: result.name,
          applicationNumber: result.applicationNumber,
          dob: result.dob
        };
      } else if (lastAttempts === 0) {
        historyRecord.status = 'invalid';
      } else {
        historyRecord.status = 'not_found';
      }
      historyRecord.attempts = lastAttempts;
      historyRecord.lastProgress = lastProgress;
      historyRecord.finishedAt = new Date();
      await DatabaseService.saveSearchHistory(historyRecord);
      globalState.sockets.forEach((s) => s.emit('result', result));
      await sendHistory();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      globalState.sockets.forEach((s) => s.emit('error', message));
      historyRecord.status = 'error';
      historyRecord.errorMessage = message;
      historyRecord.finishedAt = new Date();
      await DatabaseService.saveSearchHistory(historyRecord);
      await sendHistory();
    } finally {
      globalState.running = false;
      globalState.sockets.forEach((s) => s.emit('status', { running: false }));
      if (USE_PLAYWRIGHT) {
        await PlaywrightService.closeBrowser();
      }
    }
  });

  socket.on('resume', async (payload) => {
    if (globalState.running) {
      socket.emit('error', 'A run is already in progress.');
      return;
    }
    const id = String(payload?.id || '').trim();
    if (!id) {
      socket.emit('error', 'Missing history id.');
      return;
    }

    const record = await DatabaseService.getSearchHistoryById(id);
    if (!record || record.status !== 'cancelled' || !record.lastProgress) {
      socket.emit('error', 'Cannot resume this search.');
      return;
    }

    const nextDate = addOneDay(record.lastProgress.day, record.lastProgress.month, record.lastProgress.year);
    if (!nextDate) {
      socket.emit('error', 'Cannot compute next date to resume.');
      return;
    }

    globalState.running = true;
    globalState.cancelRequested = false;
    globalState.sockets.forEach((s) => s.emit('status', { running: true }));

    const log = (message: string) => {
      globalState.logs.push(message);
      if (globalState.logs.length > 500) globalState.logs.shift();
      globalState.sockets.forEach((s) => s.emit('log', message));
    };
    const isCancelled = () => globalState.cancelRequested;
    let lastAttemptsLocal = 0;
    let lastProgressLocal: { day: number; month: number; year: number } | undefined;
    const progress = (p: { attempts: number; total: number; day: number; month: number; year: number }) => {
      lastAttemptsLocal = p.attempts;
      lastProgressLocal = { day: p.day, month: p.month, year: p.year };
      globalState.lastProgress = { ...p };
      globalState.sockets.forEach((s) => s.emit('progress', p));
    };

    const historyRecord: SearchHistory = {
      rollNumber: record.rollNumber,
      startYear: record.startYear,
      endYear: record.endYear,
      startMonth: record.startMonth,
      endMonth: record.endMonth,
      usePlaywright: USE_PLAYWRIGHT,
      status: 'running',
      startedAt: new Date()
    };

    try {
      log(`Resuming search for ${record.rollNumber} from ${nextDate.day}/${nextDate.month}/${nextDate.year}`);
      const result = await runDobSearch(
        {
          rollNumber: record.rollNumber,
          startYear: record.startYear,
          endYear: record.endYear,
          startMonth: record.startMonth,
          endMonth: record.endMonth,
          concurrency: 2,
          startFrom: nextDate,
          usePlaywright: USE_PLAYWRIGHT
        },
        log,
        isCancelled,
        progress
      );

      if (globalState.cancelRequested) {
        historyRecord.status = 'cancelled';
      } else if (result) {
        historyRecord.status = 'found';
        historyRecord.result = {
          name: result.name,
          applicationNumber: result.applicationNumber,
          dob: result.dob
        };
      } else if (lastAttemptsLocal === 0) {
        historyRecord.status = 'invalid';
      } else {
        historyRecord.status = 'not_found';
      }
      historyRecord.attempts = lastAttemptsLocal;
      historyRecord.lastProgress = lastProgressLocal;
      historyRecord.finishedAt = new Date();
      await DatabaseService.saveSearchHistory(historyRecord);
      globalState.sockets.forEach((s) => s.emit('result', result));
      await sendHistory();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      globalState.sockets.forEach((s) => s.emit('error', message));
      historyRecord.status = 'error';
      historyRecord.errorMessage = message;
      historyRecord.finishedAt = new Date();
      await DatabaseService.saveSearchHistory(historyRecord);
      await sendHistory();
    } finally {
      globalState.running = false;
      globalState.sockets.forEach((s) => s.emit('status', { running: false }));
      if (USE_PLAYWRIGHT) {
        await PlaywrightService.closeBrowser();
      }
    }
  });

  socket.on('stop', () => {
    if (!globalState.running) {
      socket.emit('error', 'Nothing is running.');
      return;
    }
    globalState.cancelRequested = true;
    globalState.sockets.forEach((s) => s.emit('log', 'Stop requested. Cleaning up...'));
  });

  socket.on('disconnect', () => {
    globalState.sockets.delete(socket);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Web dashboard running at http://localhost:${PORT}`);
});
