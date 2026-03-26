import { client } from './database/database.service';
import { PlaywrightService } from './scraping/playwright.service';
import { runDobSearch } from './runner';

const USE_PLAYWRIGHT = process.env.USE_PLAYWRIGHT === '1';

async function main(rollNumbers: string[]) {
  try {
    const results = [];

    for (const rollNumber of rollNumbers) {
      console.log(`Processing ${rollNumber}`);
      const result = await runDobSearch(
        {
          rollNumber,
          startYear: 2006,
          endYear: 2006,
          startMonth: 7,
          endMonth: 12,
          concurrency: 2,
          usePlaywright: USE_PLAYWRIGHT
        },
        (message) => console.log(message)
      );
      if (result) {
        results.push({
          name: result.name,
          applicationNumber: result.applicationNumber,
          dob: result.dob
        });
      } else {
        results.push({ rollNumber, result: null });
      }
    }
    console.log('Final results:', results);
  } catch (error) {
    console.error('Error in main function:', error);
  } finally {
    if (USE_PLAYWRIGHT) {
      await PlaywrightService.closeBrowser();
    }
    await client.close();
  }
}

const rollNumbersToSearch = ['2501920110373'];
main(rollNumbersToSearch);
