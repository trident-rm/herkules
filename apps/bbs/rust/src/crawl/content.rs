//! Shared writer derivations. Raw source HTML is never stored as rendered HTML.
use super::render;
use ego_tree::NodeRef;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use scraper::{ElementRef, Html, Node, Selector};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use url::Url;
pub const RENDER_VERSION: &str = "1";
pub const NORMALIZE_VERSION: &str = "1";
pub const EXTRACT_VERSION: &str = "0";
pub fn clean(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn label(s: Option<String>) -> Option<String> {
    s.map(|s| clean(&s)).filter(|s| !s.is_empty())
}
pub fn normalized(base: &str, raw: &str) -> Option<String> {
    let mut u = Url::parse(base).ok()?.join(raw.trim()).ok()?;
    if !["http", "https"].contains(&u.scheme()) {
        return None;
    }
    u.set_fragment(None);
    let pairs: Vec<_> = u
        .query_pairs()
        .filter(|(k, _)| !k.starts_with("utm_") && !["spm", "from", "ref"].contains(&k.as_ref()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    u.set_query(None);
    if !pairs.is_empty() {
        u.query_pairs_mut().extend_pairs(pairs);
    }
    Some(u.into())
}
pub fn reference(raw: &str) -> Option<String> {
    let p = raw
        .strip_prefix("bbs://reference.com/")?
        .trim_end_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    if p.len() < 2 {
        return None;
    }
    let id = p[p.len() - 2];
    (!id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
        .then(|| format!("https://bbs.robomaster.com/article/{id}"))
}
fn host_matches(host: &str, values: &[&str]) -> bool {
    values
        .iter()
        .any(|v| host == *v || host.ends_with(&format!(".{v}")))
}
fn extension(s: &str) -> &str {
    s.rsplit('/')
        .next()
        .unwrap_or("")
        .rsplit_once('.')
        .map(|(_, x)| x)
        .unwrap_or("")
}
fn kind(s: &str) -> &'static str {
    let Ok(u) = Url::parse(s) else {
        return "other";
    };
    let h = u.host_str().unwrap_or("");
    if host_matches(h, &["github.com", "gitee.com", "gitlab.com"]) {
        "repository"
    } else if host_matches(h, &["bilibili.com", "youtube.com", "youtu.be", "vimeo.com"]) {
        "video"
    } else if host_matches(h, &["pan.baidu.com", "aliyundrive.com", "cloud.189.cn"]) {
        "cloud_drive"
    } else if [
        "zip", "rar", "7z", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "tar", "gz",
    ]
    .contains(&extension(&u.path().to_lowercase()))
    {
        "download"
    } else if [
        "docs.",
        "doc.",
        "notion.",
        "yuque.",
        "feishu.",
        "larksuite.",
    ]
    .iter()
    .any(|p| h.contains(p))
    {
        "document"
    } else {
        "other"
    }
}
pub fn is_image(url: &str, name: Option<&str>) -> bool {
    let s = name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(url)
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_lowercase();
    ["jpg", "jpeg", "png", "gif", "webp"].contains(&extension(&s))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Link {
    pub url: String,
    pub kind: String,
    pub label: Option<String>,
    pub position: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Image {
    pub url: String,
    pub alt: Option<String>,
    pub position: i32,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extracted {
    pub body_text: String,
    pub links: Vec<Link>,
    pub images: Vec<Image>,
}
impl Extracted {
    pub fn add_link(&mut self, base: &str, raw: &str, text: Option<String>) {
        let raw = raw.trim();
        if raw.is_empty() || raw.starts_with('#') {
            return;
        }
        let Some(url) = normalized(base, raw) else {
            return;
        };
        if normalized(base, base).as_ref() == Some(&url) {
            return;
        }
        let label = label(text);
        if let Some(l) = self.links.iter_mut().find(|l| l.url == url) {
            if l.label.is_none() {
                l.label = label;
            }
            return;
        }
        self.links.push(Link {
            kind: kind(&url).into(),
            url,
            label,
            position: self.links.len() as i32,
        });
    }
    pub fn add_image(&mut self, base: &str, raw: &str, text: Option<String>) {
        let raw = raw.trim();
        if raw.is_empty() {
            return;
        }
        if raw
            .split(['?', '#'])
            .next()
            .unwrap_or("")
            .to_lowercase()
            .ends_with(".svg")
        {
            return;
        }
        let Some(url) = normalized(base, raw) else {
            return;
        };
        if self.images.iter().any(|i| i.url == url) {
            return;
        }
        self.images.push(Image {
            url,
            alt: label(text),
            position: self.images.len() as i32,
        });
    }
}
#[derive(Default)]
struct Blocks {
    blocks: Vec<String>,
    current: String,
    pre: bool,
}
impl Blocks {
    fn flush(&mut self) {
        let text = if self.pre {
            self.current
                .split('\n')
                .map(str::trim_end)
                .collect::<Vec<_>>()
                .join("\n")
                .trim_matches('\n')
                .to_owned()
        } else {
            clean(&self.current)
        };
        self.current.clear();
        if text.chars().count() > 1 && self.blocks.last() != Some(&text) {
            self.blocks.push(text);
        }
    }
    fn finish(mut self) -> String {
        self.flush();
        self.blocks.join("\n\n")
    }
}
fn walk(node: NodeRef<'_, Node>, w: &mut Blocks) {
    match node.value() {
        Node::Text(t) => w.current.push_str(t),
        Node::Element(e) => {
            let name = e.name();
            if ["script", "style", "noscript", "template", "svg"].contains(&name) {
                return;
            }
            if e.attr("data-w-e-type") == Some("mathLatex")
                && let Some(tex) = e.attr("data-content")
            {
                w.current.push_str(&format!(" ${}$ ", tex.trim()));
                return;
            }
            if name == "math"
                && let Some(tex) = node
                    .descendants()
                    .filter_map(ElementRef::wrap)
                    .find(|e| e.value().name() == "annotation")
                    .map(|e| e.text().collect::<String>())
                    .filter(|s| !s.trim().is_empty())
            {
                w.current.push_str(&format!(" ${}$ ", tex.trim()));
                return;
            }
            if ["video", "iframe"].contains(&name) {
                if let Some(s) = e
                    .attr("data-file-name")
                    .or(e.attr("src"))
                    .filter(|s| !s.trim().is_empty())
                {
                    w.flush();
                    w.current.push_str(&format!("（视频：{}）", s.trim()));
                    w.flush();
                }
                return;
            }
            let block = [
                "address",
                "article",
                "aside",
                "blockquote",
                "dd",
                "details",
                "dialog",
                "div",
                "dl",
                "dt",
                "fieldset",
                "figcaption",
                "figure",
                "footer",
                "form",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "header",
                "hr",
                "li",
                "main",
                "nav",
                "ol",
                "p",
                "pre",
                "section",
                "summary",
                "table",
                "tbody",
                "tfoot",
                "thead",
                "tr",
                "ul",
            ]
            .contains(&name);
            if block {
                w.flush();
            }
            let old_pre = w.pre;
            if name == "pre" {
                w.pre = true;
            }
            if name == "br" {
                w.current.push('\n');
            }
            for n in node.children() {
                walk(n, w);
            }
            if ["td", "th"].contains(&name) {
                w.current.push(' ');
            }
            if block {
                w.flush();
            }
            w.pre = old_pre;
        }
        _ => {
            for n in node.children() {
                walk(n, w);
            }
        }
    }
}
fn html_extract(raw: &str, base: &str, out: &mut Extracted) -> String {
    let doc = Html::parse_fragment(raw);
    let mut w = Blocks::default();
    walk(doc.tree.root(), &mut w);
    for a in doc.select(&Selector::parse("a[href]").unwrap()) {
        out.add_link(
            base,
            a.value().attr("href").unwrap(),
            Some(a.text().collect()),
        );
    }
    for a in doc.select(&Selector::parse("[data-w-e-type=reference][data-link]").unwrap()) {
        if let Some(u) = reference(a.value().attr("data-link").unwrap()) {
            out.add_link(base, &u, None);
        }
    }
    for i in doc.select(&Selector::parse("img[src]").unwrap()) {
        out.add_image(
            base,
            i.value().attr("src").unwrap(),
            i.value()
                .attr("alt")
                .filter(|s| !s.trim().is_empty())
                .or(i.value().attr("title"))
                .map(str::to_owned),
        );
    }
    w.finish()
}
pub fn extract(format: &str, raw: &str, base: &str) -> Extracted {
    let mut out = Extracted::default();
    if format == "html" {
        out.body_text = html_extract(raw, base, &mut out);
        return out;
    }
    let mut w = Blocks::default();
    let mut links: Vec<(String, String)> = Vec::new();
    let mut image: Option<(String, String)> = None;
    for event in Parser::new_ext(
        raw,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    ) {
        match event {
            Event::Start(Tag::Link { dest_url, .. }) => {
                links.push((dest_url.into_string(), String::new()))
            }
            Event::End(TagEnd::Link) => {
                if let Some((u, t)) = links.pop() {
                    out.add_link(base, &u, Some(t));
                }
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                image = Some((dest_url.into_string(), String::new()))
            }
            Event::End(TagEnd::Image) => {
                if let Some((u, t)) = image.take() {
                    out.add_image(base, &u, Some(t));
                }
            }
            Event::Text(t) | Event::Code(t) => {
                if let Some((_, alt)) = &mut image {
                    alt.push_str(&t);
                } else {
                    w.current.push_str(&t);
                    if let Some((_, label)) = links.last_mut() {
                        label.push_str(&t);
                    }
                }
            }
            Event::Start(Tag::CodeBlock(_)) => {
                w.flush();
                w.pre = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                w.flush();
                w.pre = false;
            }
            Event::Start(
                Tag::Paragraph | Tag::Heading { .. } | Tag::Item | Tag::TableRow | Tag::TableHead,
            ) => w.flush(),
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::TableRow
                | TagEnd::TableHead,
            ) => w.flush(),
            Event::End(TagEnd::TableCell) => w.current.push(' '),
            Event::SoftBreak => w.current.push(' '),
            Event::HardBreak => w.current.push('\n'),
            Event::Rule => w.flush(),
            Event::Html(h) | Event::InlineHtml(h) => {
                let nested = html_extract(&h, base, &mut out);
                if !nested.is_empty() {
                    w.current.push(' ');
                    w.current.push_str(&nested);
                    w.current.push(' ');
                }
            }
            _ => {}
        }
    }
    out.body_text = w.finish();
    out
}
pub fn render_html(format: &str, raw: &str, base: &str, title: &str, links: &[Link]) -> String {
    let source = if format == "markdown" {
        let parser = Parser::new_ext(
            raw,
            Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
        )
        .map(|e| match e {
            Event::Start(Tag::HtmlBlock) => Event::Start(Tag::Paragraph),
            Event::End(TagEnd::HtmlBlock) => Event::End(TagEnd::Paragraph),
            Event::Html(h) => Event::Text(h.trim_end_matches('\n').to_owned().into()),
            Event::InlineHtml(h) => Event::Text(h),
            Event::Start(Tag::Strikethrough) => Event::Html("<s>".into()),
            Event::End(TagEnd::Strikethrough) => Event::Html("</s>".into()),
            Event::TaskListMarker(checked) => Event::Html(
                if checked {
                    "<input type=\"checkbox\" checked=\"\" disabled=\"\">"
                } else {
                    "<input type=\"checkbox\" disabled=\"\">"
                }
                .into(),
            ),
            e => e,
        });
        let mut html = String::new();
        pulldown_cmark::html::push_html(&mut html, parser);
        html
    } else {
        render::rewrite(raw, links)
    };
    let mut builder = ammonia::Builder::default();
    builder
        .tags(render::TAGS.iter().copied().collect())
        .generic_attributes(["lang", "title", "style"].into_iter().collect())
        .tag_attributes(render::attributes())
        .url_schemes(render::SCHEMES.iter().copied().collect())
        .link_rel(None);
    if let Ok(base) = Url::parse(base) {
        builder.url_relative(ammonia::UrlRelative::RewriteWithBase(base));
    }
    let base = Url::parse(base).ok();
    builder.attribute_filter(move |tag, attr, value| {
        if attr == "style" {
            return render::style(tag, value).map(Cow::Owned);
        }
        if attr == "class" && tag == "code" {
            return Some(Cow::Owned(
                value
                    .split_whitespace()
                    .filter(|v| v.starts_with("language-"))
                    .collect::<Vec<_>>()
                    .join(" "),
            ));
        }
        if (attr == "width" || attr == "height") && value.trim() == "auto"
            || attr == "poster" && value.trim().is_empty()
            || tag == "iframe" && attr == "src" && !render::embed(value)
        {
            return None;
        }
        if tag == "input" && attr == "type" && !value.trim().eq_ignore_ascii_case("checkbox") {
            return None;
        }
        if ["href", "src", "poster", "cite"].contains(&attr) {
            return Some(
                base.as_ref()
                    .and_then(|base| base.join(value).ok())
                    .map(|url| Cow::Owned(url.to_string()))
                    .unwrap_or(Cow::Borrowed(value)),
            );
        }
        Some(Cow::Borrowed(value))
    });
    // Force attributes after sanitizing; values are fixed literals, not source input.
    let html = builder.clean(&source).to_string();
    let mut doc = Html::parse_fragment(&html);
    let ids: Vec<_> = doc
        .tree
        .nodes()
        .filter(|n| matches!(n.value(), Node::Element(_)))
        .map(|n| n.id())
        .collect();
    for id in ids {
        let mut n = doc.tree.get_mut(id).unwrap();
        if let Node::Element(e) = n.value() {
            let forced: &[(&str, &str)] = match e.name() {
                "a" => &[
                    ("target", "_blank"),
                    ("rel", "noopener noreferrer nofollow"),
                ],
                "img" => &[("loading", "lazy"), ("referrerpolicy", "no-referrer")],
                "video" => &[
                    ("controls", ""),
                    ("preload", "metadata"),
                    ("playsinline", ""),
                ],
                "iframe" => &[("allowfullscreen", ""), ("loading", "lazy")],
                "input" => &[("disabled", "")],
                _ => &[],
            };
            for (k, v) in forced {
                let template = Html::parse_fragment(&format!("<p {k}=\"{v}\"></p>"));
                let element = template
                    .select(&Selector::parse("p").unwrap())
                    .next()
                    .unwrap();
                e.attrs.retain(|(name, _)| name.local.as_ref() != *k);
                e.attrs.extend(element.value().attrs.iter().cloned());
            }
        }
    }
    let html = doc.root_element().inner_html();
    let trimmed = html.trim_start();
    if trimmed.starts_with("<h1")
        && trimmed[3..].starts_with(['>', ' '])
        && let Some(end) = trimmed.find("</h1>")
        && let Some(start) = trimmed.find('>')
    {
        let text = Html::parse_fragment(&trimmed[start + 1..end])
            .root_element()
            .text()
            .collect::<String>();
        if clean(&text).to_lowercase() == clean(title).to_lowercase() {
            return trimmed[end + 5..].trim_start().into();
        }
    }
    html
}
#[cfg(test)]
mod security_tests {
    use super::*;
    #[test]
    fn sanitizer_rejects_active_content() {
        let raw = r#"<script>alert(1)</script><svg onload="alert(2)"></svg><p onclick="alert(3)"><a href="jav&#x61;script:alert(4)">bad</a><img src="data:text/html,x" onerror="alert(5)"><iframe src="javascript:alert(6)"></iframe></p>"#;
        let html = render_html(
            "html",
            raw,
            "https://bbs.robomaster.com/article/1",
            "Title",
            &[],
        );
        assert!(
            !html.contains("<script")
                && !html.contains("<svg")
                && !html.contains("onclick")
                && !html.contains("onerror")
                && !html.contains("href=\"javascript:")
                && !html.contains("data:"),
            "{html}"
        );
    }
    #[test]
    fn markdown_html_is_text() {
        let html = render_html(
            "markdown",
            "<script>alert(1)</script>\n\n**safe**",
            "https://bbs.robomaster.com/article/1",
            "Title",
            &[],
        );
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }
}
