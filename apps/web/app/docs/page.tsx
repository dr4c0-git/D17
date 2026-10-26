import type { Metadata } from "next";
import { ContentShell, Markdown, PageList } from "@/components/content-shell";
import { DOC_PAGES, render } from "@/lib/site-content";

export const metadata: Metadata = {
  title: "Docs - D17",
  description: "How D17 launches work: user guide, contracts explained, technical reference.",
};

export default function DocsIndex() {
  return (
    <ContentShell section="docs" aside={<PageList title="Documents" pages={DOC_PAGES} />}>
      <Markdown html={render("docs/README.md")} />
    </ContentShell>
  );
}
