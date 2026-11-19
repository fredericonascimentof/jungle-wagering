import { connectDatabase } from './orm';
const orm = await connectDatabase();
try { await orm.migrator.up(); console.log('Migrations aplicadas.'); }
finally { await orm.close(true); }
