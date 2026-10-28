// Claude Code PostToolUse hook: formats the file an Edit/Write just touched, so agent edits land in
// repo style without a separate format pass. Never blocks the agent; failures are silent.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

try {
    const file = JSON.parse(readFileSync(0, 'utf8')).tool_input?.file_path;
    if (!file) process.exit(0);
    if (extname(file) === '.rs') {
        spawnSync('rustfmt', ['--edition', '2021', file], { stdio: 'ignore' });
    } else {
        const prettier = await import('prettier');
        const info = await prettier.getFileInfo(file, {
            ignorePath: ['.gitignore', '.prettierignore'],
        });
        if (!info.ignored && info.inferredParser) {
            const source = readFileSync(file, 'utf8');
            const options = { ...(await prettier.resolveConfig(file)), filepath: file };
            const formatted = await prettier.format(source, options);
            if (formatted !== source) writeFileSync(file, formatted);
        }
    }
} catch {
    // Unreadable hook input and unparseable mid-edit files are left alone; `pnpm check` reports
    // the files.
}
