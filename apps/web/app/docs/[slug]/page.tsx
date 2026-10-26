import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentShell, Markdown, PageList } from "@/components/content-shell";
import { DOC_PAGES, markdownOf, render, summaryOf, titleOf } from "@/lib/site-content";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_PAGES.map((page) => ({ slug: page.route.split("/").pop()! }));
}

function pageOf(slug: string) {
  return DOC_PAGES.find((page) => page.route === `/docs/${slug}`);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const page = pageOf((await params).slug);
  if (!page) return {};
  const markdown = markdownOf(page.file);
  return { title: `${titleOf(markdown)} - D17`, description: summaryOf(markdown) };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const page = pageOf((await params).slug);
  if (!page) notFound();
  return (
    <ContentShell section="docs" aside={<PageList title="Documents" pages={DOC_PAGES} current={page.route} />}>
      <Markdown html={render(page.file)} />
    </ContentShell>
  );
}
