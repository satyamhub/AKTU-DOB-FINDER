import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { runDobSearch } from './runner';
import { PlaywrightService } from './scraping/playwright.service';

const USE_PLAYWRIGHT = process.env.USE_PLAYWRIGHT === '1';
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

let running = false;
let cancelRequested = false;

io.on('connection', (socket) => {
  socket.emit('status', { running });

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

    if (!rollNumber || !Number.isFinite(startYear) || !Number.isFinite(endYear) || !Number.isFinite(startMonth) || !Number.isFinite(endMonth)) {
      socket.emit('error', 'Please provide roll number, start/end year, and start/end month.');
      return;
    }

    running = true;
    cancelRequested = false;
    io.emit('status', { running });

    const log = (message: string) => io.emit('log', message);
    const isCancelled = () => cancelRequested;

    try {
      log(`Starting search for ${rollNumber} (${startYear}-${endYear})`);
      const result = await runDobSearch(
        { rollNumber, startYear, endYear, startMonth, endMonth, usePlaywright: USE_PLAYWRIGHT },
        log,
        isCancelled
      );
      io.emit('result', result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.emit('error', message);
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
