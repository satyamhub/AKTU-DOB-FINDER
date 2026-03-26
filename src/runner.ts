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
  usePlaywright: boolean;
}

export type LogFn = (message: string) => void;
export type IsCancelledFn = () => boolean;

const REQUEST_DELAY_MS = 1200;
const MAX_ATTEMPTS_PER_ROLL = 2000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const withJitter = (ms: number) => ms + Math.floor(Math.random() * 250);

export async function runDobSearch(
  options: RunOptions,
  log: LogFn,
  isCancelled: IsCancelledFn = () => false
): Promise<Student | null> {
  const { rollNumber, startYear, endYear, startMonth, endMonth, usePlaywright } = options;

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
  for (let year = startYear; year <= endYear; year++) {
    const monthStart = year === startYear ? startMonth : 1;
    const monthEnd = year === endYear ? endMonth : 12;
    for (let month = monthStart; month <= monthEnd; month++) {
      const daysInMonth = DateUtils.getDaysInMonth(month, year);
      for (let day = 1; day <= daysInMonth; day++) {
        if (isCancelled()) {
          log('Cancelled by user.');
          return null;
        }
        attempts += 1;
        if (attempts > MAX_ATTEMPTS_PER_ROLL) {
          log(`Stopping after ${MAX_ATTEMPTS_PER_ROLL} attempts for ${rollNumber}`);
          return null;
        }
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
            log(`Found: ${result.name} ${result.applicationNumber} ${result.dob}`);
            await DatabaseService.saveToDatabase(result);
            return result;
          }
        } catch (error) {
          log(`Error in execution: ${(error as Error).message}`);
        }
        await sleep(withJitter(REQUEST_DELAY_MS));
      }
    }
  }

  log(`No result found for roll number ${rollNumber}`);
  return null;
}
