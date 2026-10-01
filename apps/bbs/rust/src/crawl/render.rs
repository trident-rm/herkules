//! Sanitizer policy ported from content/render.ts (render version 1).
use super::content::{Link, reference};
use regex::Regex;
use std::collections::{HashMap, HashSet};
pub const TAGS: &[&str] = &[
    "a",
    "abbr",
    "acronym",
    "area",
    "article",
    "aside",
    "b",
    "bdi",
    "bdo",
    "blockquote",
    "br",
    "caption",
    "center",
    "cite",
    "code",
    "col",
    "colgroup",
    "data",
    "dd",
    "del",
    "details",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "li",
    "map",
    "mark",
    "nav",
    "ol",
    "p",
    "pre",
    "q",
    "rp",
    "rt",
    "rtc",
    "ruby",
    "s",
    "samp",
    "small",
    "span",
    "strike",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "tt",
    "u",
    "ul",
    "var",
    "wbr",
    "video",
    "source",
    "iframe",
    "input",
    "math",
    "semantics",
    "annotation",
    "mrow",
    "mi",
    "mo",
    "mn",
    "mtext",
    "ms",
    "mspace",
    "msub",
    "msup",
    "msubsup",
    "mfrac",
    "msqrt",
    "mroot",
    "mstyle",
    "mtable",
    "mtr",
    "mtd",
    "mover",
    "munder",
    "munderover",
    "mpadded",
    "mphantom",
    "menclose",
    "merror",
    "mmultiscripts",
    "mprescripts",
    "none",
];
pub const SCHEMES: &[&str] = &[
    "bitcoin",
    "ftp",
    "ftps",
    "geo",
    "http",
    "https",
    "im",
    "irc",
    "ircs",
    "magnet",
    "mailto",
    "mms",
    "mx",
    "news",
    "nntp",
    "openpgp4fpr",
    "sip",
    "sms",
    "smsto",
    "ssh",
    "tel",
    "url",
    "webcal",
    "wtai",
    "xmpp",
];
pub const MATH_TAGS: &[&str] = &[
    "math",
    "semantics",
    "annotation",
    "mrow",
    "mi",
    "mo",
    "mn",
    "mtext",
    "ms",
    "mspace",
    "msub",
    "msup",
    "msubsup",
    "mfrac",
    "msqrt",
    "mroot",
    "mstyle",
    "mtable",
    "mtr",
    "mtd",
    "mover",
    "munder",
    "munderover",
    "mpadded",
    "mphantom",
    "menclose",
    "merror",
    "mmultiscripts",
    "mprescripts",
    "none",
];
pub const MATH_ATTRS: &[&str] = &[
    "xmlns",
    "display",
    "mathvariant",
    "mathsize",
    "mathcolor",
    "displaystyle",
    "scriptlevel",
    "stretchy",
    "fence",
    "separator",
    "form",
    "lspace",
    "rspace",
    "symmetric",
    "largeop",
    "movablelimits",
    "accent",
    "accentunder",
    "linethickness",
    "columnalign",
    "rowalign",
    "columnspacing",
    "rowspacing",
    "columnlines",
    "rowlines",
    "frame",
    "width",
    "height",
    "depth",
    "voffset",
    "lquote",
    "rquote",
    "notation",
    "encoding",
    "open",
    "close",
    "separators",
    "minsize",
    "maxsize",
];
pub const NAMED: &[&str] = &[
    "red",
    "blue",
    "green",
    "orange",
    "purple",
    "yellow",
    "pink",
    "brown",
    "teal",
    "navy",
    "maroon",
    "olive",
    "gold",
    "crimson",
    "tomato",
    "coral",
    "orangered",
    "darkred",
    "darkblue",
    "darkgreen",
    "royalblue",
    "dodgerblue",
    "steelblue",
    "skyblue",
    "deepskyblue",
    "seagreen",
    "limegreen",
    "lime",
    "magenta",
    "fuchsia",
    "violet",
    "indigo",
    "salmon",
    "khaki",
    "chocolate",
    "firebrick",
    "goldenrod",
    "darkorange",
];
pub fn attributes() -> HashMap<&'static str, HashSet<&'static str>> {
    let mut a = HashMap::new();
    a.insert(
        "a",
        ["href", "hreflang", "target", "rel"].into_iter().collect(),
    );
    a.insert("bdo", ["dir"].into_iter().collect());
    a.insert("blockquote", ["cite"].into_iter().collect());
    a.insert(
        "col",
        ["align", "char", "charoff", "span"].into_iter().collect(),
    );
    a.insert(
        "colgroup",
        ["align", "char", "charoff", "span"].into_iter().collect(),
    );
    a.insert("del", ["cite", "datetime"].into_iter().collect());
    a.insert("hr", ["align", "size", "width"].into_iter().collect());
    a.insert(
        "img",
        [
            "align",
            "alt",
            "height",
            "src",
            "width",
            "loading",
            "referrerpolicy",
        ]
        .into_iter()
        .collect(),
    );
    a.insert("ins", ["cite", "datetime"].into_iter().collect());
    a.insert("ol", ["start"].into_iter().collect());
    a.insert("q", ["cite"].into_iter().collect());
    a.insert(
        "table",
        ["align", "char", "charoff", "summary"]
            .into_iter()
            .collect(),
    );
    a.insert("tbody", ["align", "char", "charoff"].into_iter().collect());
    a.insert(
        "td",
        ["align", "char", "charoff", "colspan", "headers", "rowspan"]
            .into_iter()
            .collect(),
    );
    a.insert("tfoot", ["align", "char", "charoff"].into_iter().collect());
    a.insert(
        "th",
        [
            "align", "char", "charoff", "colspan", "headers", "rowspan", "scope",
        ]
        .into_iter()
        .collect(),
    );
    a.insert("thead", ["align", "char", "charoff"].into_iter().collect());
    a.insert("tr", ["align", "char", "charoff"].into_iter().collect());
    a.insert(
        "video",
        [
            "src",
            "poster",
            "width",
            "height",
            "preload",
            "controls",
            "playsinline",
        ]
        .into_iter()
        .collect(),
    );
    a.insert("source", ["src", "type"].into_iter().collect());
    a.insert(
        "iframe",
        ["src", "width", "height", "allowfullscreen", "loading"]
            .into_iter()
            .collect(),
    );
    a.insert(
        "input",
        ["type", "checked", "disabled"].into_iter().collect(),
    );
    a.insert("code", ["class"].into_iter().collect());
    for &tag in MATH_TAGS {
        a.insert(tag, MATH_ATTRS.iter().copied().collect());
    }
    a
}
pub fn embed(s: &str) -> bool {
    url::Url::parse(s.trim()).is_ok_and(|u| {
        u.scheme() == "https"
            && [
                "player.bilibili.com",
                "www.youtube.com",
                "www.youtube-nocookie.com",
            ]
            .contains(&u.host_str().unwrap_or(""))
    })
}
fn escaped(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
pub fn rewrite(raw: &str, links: &[Link]) -> String {
    let markers =
        Regex::new(r#"<span\b([^>]*\bdata-w-e-type="reference"[^>]*)>([^<]*)</span>"#).unwrap();
    let target = Regex::new(r#"\bdata-link="(bbs://reference\.com/[^\"]*?/(\d+))""#).unwrap();
    let post = Regex::new(r"^https?://bbs\.robomaster\.com/article/(\d+)(?:[/?#]|$)").unwrap();
    let html = markers.replace_all(raw, |c: &regex::Captures<'_>| {
        let text = c[2].trim();
        let Some(t) = target.captures(&c[1]) else {
            return text.to_owned();
        };
        let Some(url) = reference(&t[1]) else {
            return text.to_owned();
        };
        let id = url.rsplit('/').next().unwrap();
        let label = if text.is_empty() {
            format!("[{}]", &t[2])
        } else {
            text.to_owned()
        };
        let title = links
            .iter()
            .find(|l| post.captures(&l.url).is_some_and(|m| &m[1] == id))
            .and_then(|l| l.label.as_deref())
            .map(|s| format!(" {}", escaped(s)))
            .unwrap_or_default();
        format!("<a href=\"{url}\">{label}{title}</a>")
    });
    let embeds =
        Regex::new(r#"(?is)<iframe\b((?:"[^"]*"|'[^']*'|[^>"'])*)>(?:\s*</iframe>)?"#).unwrap();
    let src = Regex::new(r#"\bsrc\s*=\s*"([^"]*)""#).unwrap();
    embeds
        .replace_all(&html, |c: &regex::Captures<'_>| {
            let Some(s) = src.captures(&c[1]) else {
                return String::new();
            };
            if embed(&s[1].replace("&amp;", "&")) {
                c[0].to_owned()
            } else {
                format!("<p><a href=\"{}\">{}</a></p>", &s[1], &s[1])
            }
        })
        .into_owned()
}
fn length(s: &str) -> bool {
    s == "0"
        || ["px", "em", "rem", "%", "pt"].iter().any(|u| {
            s.strip_suffix(u)
                .and_then(|s| s.parse::<f64>().ok())
                .is_some_and(|n| n.is_finite() && n >= 0.0)
        })
}
fn color(s: &str) -> Option<[f64; 3]> {
    if let Some(h) = s.strip_prefix('#') {
        if !h.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        if h.len() == 3 {
            return Some([
                u8::from_str_radix(&h[0..1], 16).ok()? as f64 * 17.,
                u8::from_str_radix(&h[1..2], 16).ok()? as f64 * 17.,
                u8::from_str_radix(&h[2..3], 16).ok()? as f64 * 17.,
            ]);
        }
        if h.len() == 6 || h.len() == 8 {
            if h.len() == 8 && u8::from_str_radix(&h[6..8], 16).ok()? < 25 {
                return None;
            }
            return Some([
                u8::from_str_radix(&h[0..2], 16).ok()? as f64,
                u8::from_str_radix(&h[2..4], 16).ok()? as f64,
                u8::from_str_radix(&h[4..6], 16).ok()? as f64,
            ]);
        }
    }
    let rgb = s
        .strip_prefix("rgba(")
        .or_else(|| s.strip_prefix("rgb("))
        .and_then(|s| s.strip_suffix(')'));
    if let Some(rgb) = rgb {
        let parts: Vec<_> = rgb
            .split([',', '/', ' '])
            .filter(|s| !s.is_empty())
            .collect();
        if parts.len() < 3 {
            return None;
        }
        fn number(s: &str) -> Option<f64> {
            if let Some(s) = s.strip_suffix('%') {
                Some(s.parse::<f64>().ok()? * 2.55)
            } else {
                s.parse().ok()
            }
        }
        if let Some(alpha) = parts.get(3) {
            let a = if let Some(s) = alpha.strip_suffix('%') {
                s.parse::<f64>().unwrap_or(100.) / 100.
            } else {
                alpha.parse::<f64>().unwrap_or(1.)
            };
            if a < 0.1 {
                return None;
            }
        }
        return Some([number(parts[0])?, number(parts[1])?, number(parts[2])?]);
    }
    NAMED.contains(&s).then_some([255., 0., 0.])
}
fn chromatic(c: [f64; 3]) -> bool {
    c.into_iter().fold(f64::NEG_INFINITY, f64::max) - c.into_iter().fold(f64::INFINITY, f64::min)
        >= 40.
}
pub fn style(tag: &str, css: &str) -> Option<String> {
    let mut kept = Vec::new();
    let mut explicit = false;
    let mut background = None;
    for declaration in css.split(';') {
        let Some((property, value)) = declaration.split_once(':') else {
            continue;
        };
        let property = property.trim().to_lowercase();
        let value = value
            .trim()
            .strip_suffix("!important")
            .unwrap_or(value.trim())
            .trim()
            .to_lowercase();
        if value.is_empty()
            || [
                "url(",
                "expression",
                "javascript",
                "var(",
                "\\",
                "/*",
                "<",
                ">",
                "@",
            ]
            .iter()
            .any(|s| value.contains(s))
        {
            continue;
        }
        let keep = match property.as_str() {
            "text-align" => ["left", "center", "right", "justify"].contains(&value.as_str()),
            "text-indent" => length(&value),
            "font-weight" => {
                ["bold", "bolder", "normal", "lighter"].contains(&value.as_str())
                    || value.len() == 3 && value.bytes().all(|c| c.is_ascii_digit())
            }
            "font-style" => ["italic", "oblique", "normal"].contains(&value.as_str()),
            "text-decoration" | "text-decoration-line" => value
                .split_whitespace()
                .all(|s| ["underline", "line-through", "overline", "none"].contains(&s)),
            "font-size" => {
                let px = if let Some(s) = value.strip_suffix("px") {
                    s.parse::<f64>().ok()
                } else {
                    value
                        .strip_suffix("rem")
                        .or_else(|| value.strip_suffix("em"))
                        .and_then(|s| s.parse::<f64>().ok())
                        .map(|n| n * 16.)
                };
                px.is_some_and(|n| (11. ..=40.).contains(&n))
            }
            "vertical-align" => [
                "baseline",
                "sub",
                "super",
                "top",
                "middle",
                "bottom",
                "text-top",
                "text-bottom",
            ]
            .contains(&value.as_str()),
            "white-space" => ["normal", "nowrap", "pre", "pre-wrap"].contains(&value.as_str()),
            "width" | "max-width" => {
                ["img", "video", "iframe", "table", "td", "th", "col"].contains(&tag)
                    && (value == "auto" || length(&value))
            }
            "height" => ["video", "iframe"].contains(&tag) && length(&value),
            "color" => {
                let keep = color(&value).is_some_and(chromatic);
                if keep {
                    explicit = true;
                }
                keep
            }
            "background-color" => {
                let c = color(&value).filter(|&c| chromatic(c));
                if let Some(c) = c {
                    background = Some(c);
                }
                c.is_some()
            }
            _ => false,
        };
        if keep {
            kept.push(format!("{property}: {value}"));
        }
    }
    if let Some(c) = background
        && !explicit
    {
        kept.push(
            if c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722 > 140. {
                "color: #1c2433"
            } else {
                "color: #f2f4f7"
            }
            .into(),
        );
    }
    (!kept.is_empty()).then(|| kept.join("; "))
}
