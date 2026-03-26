import { DatabaseService } from './database/database.service';
import { ScrapingService } from './scraping/scraping.service';
import { PlaywrightService } from './scraping/playwright.service';
import { DateUtils } from './utils/date.utils';
import { Student } from './interfaces';

export interface RunOptions {
  rollNumber: string;
  startYear: number;
  endYear: number;
  startMonth: number;
  endMonth: number;
  concurrency: number;
  startFrom?: { day: number; month: number; year: number };
  usePlaywright: boolean;
}

export type LogFn = (message: string) => void;
export type IsCancelledFn = () => boolean;
export type ProgressFn = (payload: { attempts: number; total: number; day: number; month: number; year: number }) => void;

const REQUEST_DELAY_MS = 1200;
const MAX_ATTEMPTS_PER_ROLL = 2000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const withJitter = (ms: number) => ms + Math.floor(Math.random() * 250);

export async function runDobSearch(
  options: RunOptions,
  log: LogFn,
  isCancelled: IsCancelledFn = () => false,
  onProgress: ProgressFn = () => {}
): Promise<Student | null> {
  const { rollNumber, startYear, endYear, startMonth, endMonth, concurrency, startFrom, usePlaywright } = options;

  if (isCancelled()) {
    log('Cancelled before start.');
    return null;
  }

  const cached = await DatabaseService.findInDatabase(rollNumber);
  if (cached) {
    log(`Found in DB: ${cached.applicationNumber} ${cached.name} ${cached.dob ?? ''}`.trim());
    return cached;
  }

  const isValid = usePlaywright
    ? await PlaywrightService.validateRollNumber(rollNumber)
    : await ScrapingService.validateRollNumber(rollNumber);

  if (!isValid) {
    log(`Invalid roll number format or not found: ${rollNumber}`);
    return null;
  }

  let attempts = 0;
  const dates: Array<{ day: number; month: number; year: number }> = [];
  for (let year = startYear; year <= endYear; year++) {
    const monthStart = year === startYear ? startMonth : 1;
    const monthEnd = year === endYear ? endMonth : 12;
    for (let month = monthStart; month <= monthEnd; month++) {
      const daysInMonth = DateUtils.getDaysInMonth(month, year);
      for (let day = 1; day <= daysInMonth; day++) {
        if (startFrom) {
          const afterStart =
            year > startFrom.year ||
            (year === startFrom.year && (month > startFrom.month || (month === startFrom.month && day >= startFrom.day)));
          if (!afterStart) {
            continue;
          }
        }
        dates.push({ day, month, year });
      }
    }
  }

  const total = dates.length;
  let index = 0;
  let foundResult: Student | null = null;
  const workerCount = Math.max(1, Math.min(concurrency, 3));

  const worker = async () => {
    while (true) {
      if (isCancelled()) {
        return;
      }
      if (foundResult) {
        return;
      }
      const currentIndex = index;
      if (currentIndex >= dates.length) {
        return;
      }
      index += 1;

      attempts += 1;
      if (attempts > MAX_ATTEMPTS_PER_ROLL) {
        log(`Stopping after ${MAX_ATTEMPTS_PER_ROLL} attempts for ${rollNumber}`);
        return;
      }

      const { day, month, year } = dates[currentIndex];
      onProgress({ attempts, total, day, month, year });
      log(`Trying date: ${day}/${month}/${year}`);
      try {
        const parseResult = usePlaywright
          ? await PlaywrightService.find(rollNumber, day, month, year)
          : await ScrapingService.find(rollNumber, day, month, year);
        if (parseResult) {
          const result: Student = {
            ...parseResult,
            dob: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`
          };
          foundResult = result;
          log(`Found: ${result.name} ${result.applicationNumber} ${result.dob}`);
          await DatabaseService.saveToDatabase(result);
          return;
        }
      } catch (error) {
        log(`Error in execution: ${(error as Error).message}`);
      }
      await sleep(withJitter(REQUEST_DELAY_MS));
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (isCancelled()) {
    log('Cancelled by user.');
    return null;
  }

  if (foundResult) {
    return foundResult;
  }

  log(`No result found for roll number ${rollNumber}`);
  return null;
}
