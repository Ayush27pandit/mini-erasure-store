import app from './app.js';
import { PORT } from './config/constants.js';
import { repairService } from './repair/repair.service.js';

app.listen(PORT, () => {
  console.log(`Main server running on http://localhost:${PORT}`);
  console.log('Starting background repair daemon...');
  repairService.start();
});
