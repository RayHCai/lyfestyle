const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};

/** Readable plain text from an HTML fragment, for handing email and LMS bodies to the agent. */
export function htmlToText(html: string): string {
    return html
        .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
            if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? match;
            const point =
                code[1]?.toLowerCase() === 'x'
                    ? parseInt(code.slice(2), 16)
                    : parseInt(code.slice(1), 10);
            // fromCodePoint throws outside Unicode's range, e.g. on `&#99999999;`.
            return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
        })
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function truncate(text: string, max: number): string {
    return text.length > max
        ? `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]`
        : text;
}
