import type { Metadata } from "next";
import { ContentShell, Markdown, PageList } from "@/components/content-shell";
import { BLOG_POSTS, render } from "@/lib/site-content";

export const metadata: Metadata = {
  title: "Blog - D17",
  description: "Short essays on the ideas inside the D17 V15 launch mechanism.",
};

export default function BlogIndex() {
  return (
    <ContentShell section="blog" aside={<PageList title="Posts" pages={BLOG_POSTS} />}>
      <Markdown html={render("docs/blog/README.md")} />
    </ContentShell>
  );
}
