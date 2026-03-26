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

const wrap = (middleware: any) => (socket: any, next: any) =>
  middleware(socket.request, {} as any, next);
io.use(wrap(sessionMiddleware));
io.use((socket, next) => {
  const req = socket.request as any;
  if (req?.session?.user) return next();
  next(new Error('Unauthorized'));
});

let running = false;
let cancelRequested = false;

io.on('connection', (socket) => {
  socket.emit('status', { running });
  DatabaseService.listSearchHistory(20)
    .then((history) => socket.emit('history', history))
    .catch((err) => socket.emit('error', err instanceof Error ? err.message : String(err)));

  socket.on('start', async (payload) => {
    if (running) {
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

    running = true;
    cancelRequested = false;
    io.emit('status', { running });

    const log = (message: string) => io.emit('log', message);
    const isCancelled = () => cancelRequested;

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
        isCancelled
      );
      if (cancelRequested) {
        historyRecord.status = 'cancelled';
      } else if (result) {
        historyRecord.status = 'found';
        historyRecord.result = {
          name: result.name,
          applicationNumber: result.applicationNumber,
          dob: result.dob
        };
      } else {
        historyRecord.status = 'not_found';
      }
      historyRecord.finishedAt = new Date();
      await DatabaseService.saveSearchHistory(historyRecord);
      io.emit('result', result);
      const history = await DatabaseService.listSearchHistory(20);
      io.emit('history', history);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.emit('error', message);
      historyRecord.status = 'error';
      historyRecord.errorMessage = message;
      historyRecord.finishedAt = new Date();
      await DatabaseService.saveSearchHistory(historyRecord);
      const history = await DatabaseService.listSearchHistory(20);
      io.emit('history', history);
    } finally {
      running = false;
      io.emit('status', { running });
      if (USE_PLAYWRIGHT) {
        await PlaywrightService.closeBrowser();
      }
    }
  });

  socket.on('stop', () => {
    if (!running) {
      socket.emit('error', 'Nothing is running.');
      return;
    }
    cancelRequested = true;
    io.emit('log', 'Stop requested. Cleaning up...');
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Web dashboard running at http://localhost:${PORT}`);
});
