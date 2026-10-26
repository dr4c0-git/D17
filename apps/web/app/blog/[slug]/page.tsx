import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentShell, Markdown, PageList } from "@/components/content-shell";
import { BLOG_POSTS, markdownOf, render, summaryOf, titleOf } from "@/lib/site-content";

export const dynamicParams = false;

export function generateStaticParams() {
  return BLOG_POSTS.map((post) => ({ slug: post.route.split("/").pop()! }));
}

function postOf(slug: string) {
  return BLOG_POSTS.find((post) => post.route === `/blog/${slug}`);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const post = postOf((await params).slug);
  if (!post) return {};
  const markdown = markdownOf(post.file);
  return { title: `${titleOf(markdown)} - D17`, description: summaryOf(markdown) };
}

export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const post = postOf((await params).slug);
  if (!post) notFound();
  const index = BLOG_POSTS.indexOf(post);
  const previous = BLOG_POSTS[index - 1];
  const next = BLOG_POSTS[index + 1];
  return (
    <ContentShell section="blog" aside={<PageList title="Posts" pages={BLOG_POSTS} current={post.route} />}>
      <Markdown html={render(post.file)} />
      <nav aria-label="More posts" className="mt-10 flex flex-wrap justify-between gap-4 border-t border-hairline pt-5 text-[14px]">
        {previous ? (
          <a href={previous.route} className="text-dim hover:text-ink">
            ← {previous.nav}
          </a>
        ) : (
          <span />
        )}
        {next && (
          <a href={next.route} className="text-right text-dim hover:text-ink">
            {next.nav} →
          </a>
        )}
      </nav>
    </ContentShell>
  );
}
