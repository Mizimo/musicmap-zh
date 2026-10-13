import { convertToTraditional } from '../lib/chinese-conversion.mjs';

if (process.argv.length > 2) {
  console.error('Usage: npm run convert — derive Traditional Chinese locally from generated/locales/zh-Hans.json.');
  process.exitCode = 1;
} else {
  convertToTraditional().catch(error => {
    console.error(`Conversion stopped: ${error.code === 'ENOENT' ? 'Run source sync and Simplified translation/merge first.' : error.message}`);
    process.exitCode = 1;
  });
}
