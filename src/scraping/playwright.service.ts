import { chromium, Browser, Page } from 'playwright';
import { AKTU_URL } from '../config';
import { ParseResult } from '../interfaces';
import { ScrapingService } from './scraping.service';

export class PlaywrightService {
  private static browser: Browser | null = null;

  private static async getBrowser(): Promise<Browser> {
    if (!PlaywrightService.browser) {
      PlaywrightService.browser = await chromium.launch({ headless: true });
    }
    return PlaywrightService.browser;
  }

  private static async newPage(): Promise<Page> {
    const browser = await PlaywrightService.getBrowser();
    const page = await browser.newPage();
    return page;
  }

  static async closeBrowser(): Promise<void> {
    if (PlaywrightService.browser) {
      await PlaywrightService.browser.close();
      PlaywrightService.browser = null;
    }
  }

  static async validateRollNumber(rollNumber: string): Promise<boolean> {
    const page = await PlaywrightService.newPage();
    try {
      await page.goto(AKTU_URL, { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="txtRollNo"]', rollNumber);
      await page.click('input[name="btnProceed"]');
      await page.waitForLoadState('networkidle');

      const content = await page.content();
      const invalidMessages = [
        'गलत अनुक्रमांक',
        'आपके द्वारा प्रदान किया गया अनुक्रमांक गलत है'
      ];
      return !invalidMessages.some(msg => content.includes(msg));
    } finally {
      await page.close();
    }
  }

  static async find(rollNumber: string, day: number, month: number, year: number): Promise<ParseResult | null> {
    const page = await PlaywrightService.newPage();
    try {
      await page.goto(AKTU_URL, { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="txtRollNo"]', rollNumber);
      await page.click('input[name="btnProceed"]');

      const dobSelector = 'input[name="txtDOB"]';
      const dobValue = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;

      try {
        await page.waitForSelector(dobSelector, { timeout: 15000 });
      } catch {
        const content = await page.content();
        if (!content.includes('txtDOB')) {
          throw new Error('DOB field not found after proceeding. The flow may have changed or is blocked.');
        }
      }

      await page.fill(dobSelector, dobValue);
      await page.click('input[name="btnSearch"]');
      await page.waitForLoadState('networkidle');

      const content = await page.content();
      return ScrapingService.parseHtml(content);
    } finally {
      await page.close();
    }
  }
}
