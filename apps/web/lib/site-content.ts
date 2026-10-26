// The public documentation shown at /docs, /blog and /progress. The markdown lives in
// docs/ and CHANGELOG.md at the repository root; scripts/sync-site-content.mjs copies it
// into content/site-content.json, rendered here at build time (server components only).
import { Marked, type RendererThis, type Tokens } from "marked";
import bundle from "@/content/site-content.json";

const REPOSITORY = "https://github.com/dr4c0-git/D17";
const files: Record<string, string> = bundle.files;

export type Page = { file: string; route: string; nav: string };

export const DOC_PAGES: Page[] = [
  { file: "docs/GUIDE.md", route: "/docs/guide", nav: "User guide" },
  { file: "docs/CONTRACTS.md", route: "/docs/contracts", nav: "Contracts, explained" },
  { file: "docs/CONTRACTS_TECHNICAL.md", route: "/docs/technical", nav: "Technical reference" },
  { file: "docs/V15_HARDENING.md", route: "/docs/v15-changes", nav: "V15 changes" },
  { file: "docs/SELF_HOSTING.md", route: "/docs/self-hosting", nav: "Self-hosting" },
];

export const BLOG_POSTS: Page[] = Object.keys(files)
  .filter((file) => /^docs\/blog\/\d\d-.+\.md$/.test(file))
  .sort()
  .map((file) => ({ file, route: `/blog/${slugOf(file)}`, nav: titleOf(files[file]) }));

/** Repository file → page of this site; anything else links to the file on GitHub. */
const ROUTES: Record<string, string> = {
  "docs/README.md": "/docs",
  "docs/PROGRESS.md": "/progress",
  "CHANGELOG.md": "/progress#changelog",
  "docs/blog/README.md": "/blog",
  ...Object.fromEntries([...DOC_PAGES, ...BLOG_POSTS].map((page) => [page.file, page.route])),
};

function slugOf(file: string) {
  return file.split("/").pop()!.replace(/\.md$/, "");
}

/** The page title: the first "# " heading, without markdown. */
export function titleOf(markdown: string) {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? "D17";
  return plain(heading);
}

/** The first paragraph after the title, as plain text (for descriptions and listings). */
export function summaryOf(markdown: string) {
  const body = markdown.replace(/^#\s+.+$/m, "");
  const paragraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|\||-{3,}|\*D17 blog|>|- |\d+\. )/.test(block));
  return paragraph ? plain(paragraph.replace(/\s+/g, " ")) : "";
}

function plain(text: string) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

/** GitHub-style heading anchor, so the documents' own "#section" links keep working. */
function anchorOf(text: string) {
  return plain(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function resolveHref(href: string, from: string) {
  if (/^(?:[a-z]+:|#|\/\/)/i.test(href)) return href;
  const [target, hash = ""] = href.split("#");
  const joined = target ? normalize(`${from.split("/").slice(0, -1).join("/")}/${target}`) : from;
  const route = ROUTES[joined];
  if (route) return hash ? `${route.split("#")[0]}#${hash}` : route;
  return `${REPOSITORY}/blob/main/${joined}${hash ? `#${hash}` : ""}`;
}

function normalize(file: string) {
  const parts: string[] = [];
  for (const part of file.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function markdownOf(file: string) {
  const markdown = files[file];
  if (markdown === undefined) throw new Error(`${file} is not in the site content bundle`);
  return markdown;
}

/** Renders one repository markdown file to HTML, with links rewritten to this site. */
export function render(file: string, markdown = markdownOf(file)) {
  const used = new Map<string, number>();
  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type === "link" || token.type === "image") token.href = resolveHref(token.href, file);
    },
    renderer: {
      heading(this: RendererThis, { tokens, depth, text }: Tokens.Heading) {
        const base = anchorOf(text) || "section";
        const count = used.get(base) ?? 0;
        used.set(base, count + 1);
        const id = count ? `${base}-${count}` : base;
        return `<h${depth} id="${id}"><a href="#${id}" class="anchor" aria-hidden="true" tabindex="-1">#</a>${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link(this: RendererThis, { href, title, tokens }: Tokens.Link) {
        const external = /^https?:/i.test(href);
        const text = this.parser.parseInline(tokens);
        return `<a href="${href}"${title ? ` title="${title}"` : ""}${external ? ' rel="noopener noreferrer" target="_blank"' : ""}>${text}</a>`;
      },
    },
  });
  return marked.parse(markdown, { async: false }) as string;
}
