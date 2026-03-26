import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import qs from 'qs';
import * as cheerio from 'cheerio';
import { AKTU_URL, getRandomHeaders } from '../config';
import { ViewStateParams, ParseResult, Student } from '../interfaces';
import { DatabaseService } from '../database/database.service';

export class ScrapingService {
  private static jar = new CookieJar();
  private static client = wrapper(axios.create({ jar: ScrapingService.jar, withCredentials: true }));
  private static viewStateCache: { params: ViewStateParams; expiresAt: number } | null = null;
  private static readonly VIEWSTATE_TTL_MS = 60_000;

  private static async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private static isRetryableStatus(status?: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  private static async withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (error: any) {
        attempt += 1;
        const status = error?.response?.status;
        if (attempt > retries || !ScrapingService.isRetryableStatus(status)) {
          throw error;
        }
        if (status && status >= 500) {
          ScrapingService.viewStateCache = null;
        }
        const backoff = 500 * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * 250);
        await ScrapingService.sleep(backoff + jitter);
      }
    }
  }

  static async fetchViewStateParams(): Promise<ViewStateParams> {
    const now = Date.now();
    if (ScrapingService.viewStateCache && ScrapingService.viewStateCache.expiresAt > now) {
      return ScrapingService.viewStateCache.params;
    }

    const response = await ScrapingService.withRetry(
      () => ScrapingService.client.get(AKTU_URL, { headers: getRandomHeaders() }),
      2
    );
    const params = ScrapingService.extractViewStateParams(response.data);
    ScrapingService.viewStateCache = {
      params,
      expiresAt: now + ScrapingService.VIEWSTATE_TTL_MS
    };
    return params;
  }

  static extractViewStateParams(htmlText: string): ViewStateParams {
    const viewState = htmlText.match(/name="__VIEWSTATE" id="__VIEWSTATE" value="([^"]+)"/)?.[1] || '';
    const viewStateGenerator = htmlText.match(/name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="([^"]+)"/)?.[1] || '';
    const eventValidation = htmlText.match(/name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="([^"]+)"/)?.[1] || '';
    return { viewState, viewStateGenerator, eventValidation };
  }

  private static extractHiddenInputs(htmlText: string): Record<string, string> {
    const $ = cheerio.load(htmlText);
    const hiddenInputs: Record<string, string> = {};
    $('input[type="hidden"]').each((_, el) => {
      const name = $(el).attr('name');
      if (!name) return;
      const value = $(el).attr('value') ?? '';
      hiddenInputs[name] = value;
    });
    return hiddenInputs;
  }

  static async find(rollNumber: string, day: number, month: number, year: number): Promise<ParseResult | null> {
    const getResponse = await ScrapingService.withRetry(
      () => ScrapingService.client.get(AKTU_URL, { headers: getRandomHeaders() }),
      2
    );
    const hiddenInputs = ScrapingService.extractHiddenInputs(getResponse.data);

    const data = qs.stringify({
      ...hiddenInputs,
      'txtRollNo': rollNumber,
      'txtDOB': `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`,
      'btnSearch': 'खोजें',
      'hidForModel': hiddenInputs['hidForModel'] ?? ''
    });
  
    try {
      const response = await ScrapingService.withRetry(
        () => ScrapingService.client.post(AKTU_URL, data, {
          headers: {
            ...getRandomHeaders(),
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }),
        3
      );
      return ScrapingService.parseHtml(response.data);
    } catch (error) {
      console.error('Error in find function:', error);
      ScrapingService.viewStateCache = null;
      return null;
    } 
  }
  

  static parseHtml(htmlContent: string): ParseResult | null {
    const $ = cheerio.load(htmlContent);
    const applicationNumber = $('#lblRollNo').text().trim() || 'N/A';
    const name = $('#lblFullName').text().trim() || 'N/A';
    const COP = $('#ctl04_lblCOP').text().trim() || 'N/A';
    const sgpaValues: string[] = [];

    $('td > span:contains("SGPA")').each((index, element) => {
      const sgpaValue = $(element).parent().next('td').next('td').find('span').text().trim();
      sgpaValues.push(sgpaValue);
    });

    if (applicationNumber === 'N/A' && name === 'N/A' && sgpaValues.length === 0) {
      return null;
    }

    return {
      success: true,
      applicationNumber,
      name,
      COP,
      sgpaValues
    };
  }

  static async validateRollNumber(rollNumber: string): Promise<boolean> {
    const cleanRollNumber = rollNumber.replace(/^0+/, '');
    if (!/^\d+$/.test(cleanRollNumber) || cleanRollNumber.length < 10 || cleanRollNumber.length > 13) {
      console.log('Invalid roll number format.');
      return false;
    }

    try {
      const getResponse = await ScrapingService.withRetry(
        () => ScrapingService.client.get(AKTU_URL, { headers: getRandomHeaders() }),
        2
      );
      const hiddenInputs = ScrapingService.extractHiddenInputs(getResponse.data);

      const formData = qs.stringify({
        ...hiddenInputs,
        'txtRollNo': rollNumber,
        'btnProceed': 'आगे बढ़े'
      });

      const validationResponse = await ScrapingService.client.post(AKTU_URL, formData, {
        headers: {
          ...getRandomHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      const invalidMessages = [
        'गलत अनुक्रमांक',
        'आपके द्वारा प्रदान किया गया अनुक्रमांक गलत है'
      ];

      if (invalidMessages.some(msg => validationResponse.data.includes(msg))) {
        console.log('Invalid roll number.');
        return false;
      }

      console.log('Roll number is valid!');
      return true;
    } catch (error) {
      console.error('Error during validation:', error);
      return false;
    }
  }
}
