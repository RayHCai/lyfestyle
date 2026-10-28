import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** SOUL.md: the user's guiding doc, given to every run. The desktop app edits the same file in
 *  Settings; the runner always runs on the user's machine (ADR 0002), so both see it. */
const SOUL_FILE = join(homedir(), '.lyfestyle', 'SOUL.md');

/** The doc's text, or '' when there is none. Read per run so edits apply without a restart. */
export async function readSoul(file = SOUL_FILE): Promise<string> {
    try {
        return (await readFile(file, 'utf8')).trim();
    } catch {
        return '';
    }
}
