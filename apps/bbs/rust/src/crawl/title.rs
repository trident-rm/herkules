//! Title version 0. Golden corpus shared with the Node writer.
use super::content::clean;
use regex::{Captures, Regex};
use serde::Serialize;
use std::sync::LazyLock;
pub const TITLE_VERSION: &str = "0";
const COMP: &str = "RMUC|RMUL|RMUA|RMU|RMYC|RM|RC|ROBOCON|ROBOMASTER";
const SCHOOL: &str = "大学|学院|学校|高中|中学|职业技术学院|联队";
const TAIL: &str = "战队|队|联队|实验室|Team";
const NAME: &str = "[一-鿿A-Za-z0-9&.'’·]";
const LABELS: &[&str] = &[
    "开源",
    "分享",
    "求助",
    "求助帖",
    "技术报告",
    "硬件设计",
    "归档",
    "转载",
    "开源分享",
    "开源发布",
    "个人开源",
    "复盘开源",
    "已完结",
    "抢先体验版",
    "实验性",
    "走心帖",
    "教程",
];
const SEPARATORS: &str = "-—–+｜|·：:_,，、/";
fn regex(s: &str) -> Regex {
    Regex::new(s).expect("fixed title expression")
}
fn team_pattern() -> String {
    format!(
        r"(?:{NAME}{{1,14}}?(?:{SCHOOL})(?:[（(][^）)]{{1,12}}[）)]|[一-鿿]{{1,6}}校区)?(?:\s?(?:{NAME}| ){{1,16}}?\s?(?:{TAIL}))?|{NAME}{{1,14}}?战队)"
    )
}
fn season_pattern() -> String {
    format!(
        r"(?:(?P<comp>{COMP})\s?[-_]?\s?(?P<year>20\d{{2}}|\d{{2}})(?:[-–~](?P<year2>20\d{{2}}|\d{{2}}))?(?:赛季)?|(?P<year3>20\d{{2}}|\d{{2}})\s?(?:赛季|年))"
    )
}
static SEASON: LazyLock<Regex> = LazyLock::new(|| regex(&format!("(?i)^{}$", season_pattern())));
static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?i)^(?:(?P<comp>{COMP})\s?[-_]?\s?(?P<year>20\d{{2}}|\d{{2}})(?:[-–~](?P<year2>20\d{{2}}|\d{{2}}))?(?:赛季)?|(?P<year3>20\d{{2}}|\d{{2}})(?:赛季|年))(?P<rest>.+)$"
    ))
});
static TEAM: LazyLock<Regex> = LazyLock::new(|| regex(&format!("^{}$", team_pattern())));
static TEAM_PREFIX: LazyLock<Regex> = LazyLock::new(|| regex(&format!("^{}", team_pattern())));
static TEAM_ANY: LazyLock<Regex> = LazyLock::new(|| regex(&team_pattern()));
static TEAM_NAME: LazyLock<Regex> =
    LazyLock::new(|| regex(&format!(r"^(?:{NAME}| ){{1,16}}?\s?(?:{TAIL})$")));
static TEAM_TAIL: LazyLock<Regex> = LazyLock::new(|| regex(&format!("(?:{TAIL})$")));
static HAS_SCHOOL: LazyLock<Regex> = LazyLock::new(|| regex(SCHOOL));
static SHORT: LazyLock<Regex> = LazyLock::new(|| regex(r"^[一-鿿]+[A-Za-z0-9]*$"));
static LATIN: LazyLock<Regex> =
    LazyLock::new(|| regex(r"^[A-Za-z0-9&.'’]*[A-Za-z][A-Za-z0-9&.'’]*(?: [A-Za-z0-9&.'’]+)*$"));
static GAP: LazyLock<Regex> =
    LazyLock::new(|| regex(&format!(r"(?i)\b({COMP})[\s\-_]+(20\d{{2}})")));
static RANGE_LEFT: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?i)(?:{COMP})\s?(?P<year>20[0-9]{{2}}|[0-9]{{2}})$"
    ))
});
static RANGE_RIGHT: LazyLock<Regex> =
    LazyLock::new(|| regex(r"^(?P<year>20[0-9]{2}|[0-9]{2})(?:[^A-Za-z0-9]|$)"));
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Parts {
    pub season: Option<String>,
    pub team: Option<String>,
    pub labels: Vec<String>,
    pub topic: String,
}
struct Segment {
    text: String,
    bracketed: bool,
    lead: Option<String>,
}
fn cjk(c: char) -> bool {
    ('一'..='鿿').contains(&c)
}
fn range(before: &str, after: &[char]) -> bool {
    let Some(l) = RANGE_LEFT.captures(before.trim_end()) else {
        return false;
    };
    let after = after.iter().take(5).collect::<String>();
    let Some(r) = RANGE_RIGHT.captures(&after) else {
        return false;
    };
    let a = l["year"].parse::<u32>().unwrap() % 100;
    let b = r["year"].parse::<u32>().unwrap() % 100;
    b == (a + 1) % 100
}
fn tail_follows(rest: &[char]) -> bool {
    let head: String = rest.iter().take(3).collect();
    ["战队", "联队", "实验室"]
        .iter()
        .any(|s| head.starts_with(s))
        || rest.first() == Some(&'队')
            && !rest
                .get(1)
                .is_some_and(|c| c.is_alphanumeric() || *c == '_')
}
fn flush(buf: &mut String, gap: &mut Option<String>, bracketed: bool, out: &mut Vec<Segment>) {
    let text = buf.trim();
    if text.is_empty() {
        if let Some(gap) = gap {
            gap.push_str(buf);
        }
    } else {
        out.push(Segment {
            text: text.into(),
            bracketed,
            lead: gap.as_ref().map(|g| {
                format!(
                    "{g}{}",
                    buf.chars()
                        .take_while(|c| c.is_whitespace())
                        .collect::<String>()
                )
            }),
        });
        *gap = Some(
            buf.chars()
                .rev()
                .take_while(|c| c.is_whitespace())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
        );
    }
    buf.clear();
}
fn split_run(run: &str, bracketed: bool, out: &mut Vec<Segment>) {
    let chars: Vec<_> = run.chars().collect();
    let mut buf = String::new();
    let mut gap = None;
    for (i, &ch) in chars.iter().enumerate() {
        if SEPARATORS.contains(ch) {
            if "-–".contains(ch) && range(&buf, &chars[i + 1..]) {
                buf.push(ch);
                continue;
            }
            flush(&mut buf, &mut gap, bracketed, out);
            if let Some(g) = &mut gap {
                g.push(ch);
            }
        } else if ch.is_whitespace()
            && (i > 0 && cjk(chars[i - 1])
                || chars.get(i + 1).is_some_and(|&c| cjk(c)) && !tail_follows(&chars[i + 1..]))
        {
            flush(&mut buf, &mut gap, bracketed, out);
            if let Some(g) = &mut gap {
                g.push(ch);
            }
        } else {
            buf.push(ch);
        }
    }
    flush(&mut buf, &mut gap, bracketed, out);
}
fn segments(title: &str) -> Vec<Segment> {
    let open = ['【', '[', '「', '〔', '［'];
    let close = ['】', ']', '」', '〕', '］'];
    let mut result = Vec::new();
    let mut run = String::new();
    let mut closing = None;
    for ch in title.chars() {
        if closing.is_none()
            && let Some(i) = open.iter().position(|&c| c == ch)
        {
            split_run(&run, false, &mut result);
            run.clear();
            closing = Some(close[i]);
        } else if closing == Some(ch) {
            split_run(&run, true, &mut result);
            run.clear();
            closing = None;
        } else if closing.is_none() && close.contains(&ch) {
            split_run(&run, false, &mut result);
            run.clear();
        } else {
            run.push(ch);
        }
    }
    split_run(&run, closing.is_some(), &mut result);
    result
}
fn season(c: &Captures<'_>) -> String {
    let comp = c
        .name("comp")
        .map(|m| m.as_str().to_uppercase())
        .unwrap_or("RM".into());
    let comp = if comp == "ROBOMASTER" { "RM" } else { &comp };
    let year = c.name("year").or_else(|| c.name("year3")).unwrap().as_str();
    let mut out = format!(
        "{comp}{}{year}",
        if year.chars().count() == 2 { "20" } else { "" }
    );
    if let Some(y) = c.name("year2") {
        let last: String = y
            .as_str()
            .chars()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        out.push('-');
        out.push_str(&last);
    }
    out
}
fn short(text: &str, lead: Option<&str>) -> bool {
    let joined = lead.is_some_and(|s| {
        s.chars()
            .find(|c| !c.is_whitespace())
            .is_none_or(|c| "-—–_·/".contains(c))
    });
    if !joined || SEASON.is_match(text) || LABELS.contains(&text) {
        return false;
    }
    text.chars().count() <= 20 && LATIN.is_match(text)
        || (1..=4).contains(&text.chars().filter(|&c| cjk(c)).count())
            && text.chars().count() <= 8
            && SHORT.is_match(text)
}
pub fn split(raw: &str) -> Parts {
    let normalized = GAP.replace_all(&clean(raw), "${1}${2}").into_owned();
    let segments = segments(&normalized);
    let mut out = Parts {
        season: None,
        team: None,
        labels: Vec::new(),
        topic: String::new(),
    };
    let mut topic: Vec<(usize, String)> = Vec::new();
    let mut school_at = None;
    for (i, s) in segments.iter().enumerate() {
        let mut text = s.text.clone();
        if school_at.is_some_and(|at| i == at + 1)
            && out.team.as_ref().is_some_and(|t| !TEAM_TAIL.is_match(t))
            && (TEAM_NAME.is_match(&text) || short(&text, s.lead.as_deref()))
        {
            out.team = Some(format!("{} {text}", out.team.unwrap()));
            school_at = None;
            continue;
        }
        school_at = None;
        if out.season.is_none() {
            if let Some(c) = SEASON.captures(&text) {
                out.season = Some(season(&c));
                continue;
            }
            if let Some(c) = PREFIX.captures(&text) {
                let rest = c["rest"].trim();
                if rest.chars().count() >= 2 && !(s.bracketed && TEAM.is_match(rest)) {
                    out.season = Some(season(&c));
                    text = rest.into();
                }
            }
        }
        if s.bracketed && LABELS.contains(&text.as_str()) {
            out.labels.push(text);
            continue;
        }
        if out.team.is_none() {
            if TEAM.is_match(&text) {
                out.team = Some(text);
                school_at = Some(i);
                continue;
            }
            let candidates = [
                TEAM_PREFIX.find(&text),
                TEAM_ANY.find_iter(&text).find(|m| m.end() == text.len()),
            ];
            let mut taken = false;
            for found in candidates.into_iter().flatten() {
                let candidate = found.as_str();
                if !s.bracketed && !HAS_SCHOOL.is_match(candidate) {
                    continue;
                }
                let rest = format!("{}{}", &text[..found.start()], &text[found.end()..])
                    .trim_matches(|c| " -—–_:：".contains(c))
                    .to_owned();
                if rest.chars().count() < 2 || rest.starts_with(['的', '之']) {
                    continue;
                }
                if found.start() == 0
                    && i == segments.len() - 1
                    && rest.chars().count() <= 6
                    && !topic.is_empty()
                {
                    out.team = Some(format!("{candidate} {rest}"));
                } else {
                    out.team = Some(candidate.into());
                    topic.push((i, rest));
                }
                taken = true;
                break;
            }
            if !taken {
                topic.push((i, text));
            }
        } else {
            topic.push((i, text));
        }
    }
    let mut previous = None;
    for (index, text) in topic {
        if let Some(p) = previous {
            out.topic.push_str(if index == p + 1 {
                segments[index].lead.as_deref().unwrap_or(" ")
            } else {
                " "
            });
        }
        out.topic.push_str(&text);
        previous = Some(index);
    }
    out.topic = out
        .topic
        .trim_matches(|c: char| c.is_whitespace() || SEPARATORS.contains(c))
        .into();
    if out.topic.is_empty() {
        out.topic = out.team.clone().unwrap_or_else(|| raw.trim().into());
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corpus() {
        for line in
            include_str!("../../../tests/fixtures/title-parser/corpus.expected.jsonl").lines()
        {
            let expected: serde_json::Value = serde_json::from_str(line).unwrap();
            let raw = expected["title"].as_str().unwrap().to_owned();
            let actual = serde_json::to_value(split(&raw)).unwrap();
            let mut expected = expected;
            expected.as_object_mut().unwrap().remove("title");
            assert_eq!(actual, expected, "{raw}");
        }
    }
}
