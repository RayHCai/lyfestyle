const PAGE_LINK =
    /\[[^\]]*\]\(page:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

/** Ids of every page a markdown body links to with `[label](page:<id>)`, in first-seen order. */
export function extractPageLinks(markdown: string): string[] {
    const ids = new Set<string>();
    for (const match of markdown.matchAll(PAGE_LINK)) ids.add(match[1]!.toLowerCase());
    return [...ids];
}

/** Markdown for a link to another page. */
export function pageLink(id: string, label: string): string {
    return `[${label.replace(/[[\]]/g, '')}](page:${id})`;
}
