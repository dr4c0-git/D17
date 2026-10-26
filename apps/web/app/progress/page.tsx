import type { Metadata } from "next";
import { ContentShell, Markdown } from "@/components/content-shell";
import { markdownOf, render } from "@/lib/site-content";

export const metadata: Metadata = {
  title: "Progress - D17",
  description: "Where D17 V15 stands, what comes next, and every change so far.",
};

export default function Progress() {
  // The changelog follows the roadmap one heading level down, so the page keeps a single
  // top-level title and "Changelog" reads as a section of it.
  const changelog = markdownOf("CHANGELOG.md").replace(/^(#+) /gm, "#$1 ");
  return (
    <ContentShell section="progress">
      <Markdown html={render("docs/PROGRESS.md")} />
      <div className="mt-12 border-t border-hairline pt-4">
        <Markdown html={render("CHANGELOG.md", changelog)} />
      </div>
    </ContentShell>
  );
}
