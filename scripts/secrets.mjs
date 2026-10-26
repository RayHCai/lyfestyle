// Prints fresh values for the API's two required secrets, ready to paste into .env or Railway.
import { randomBytes } from 'node:crypto';

console.log(`API_TOKEN=${randomBytes(32).toString('base64url')}`);
console.log(`ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
