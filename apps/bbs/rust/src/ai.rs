//! Lenient normalization of model JSON. Mirrors library/ai-json.ts; malformed
//! blobs remain empty/null rather than turning corpus reads into 500s.
use crate::library::Library;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::Row;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleAi {
    pub article_id: String,
    pub status: String,
    pub overview: Option<Value>,
    pub kb: Option<Value>,
    pub images: Vec<Value>,
    pub model: Option<String>,
    pub generated_at: Option<String>,
    pub error: Option<String>,
}

impl Library {
    pub async fn ai(&self, id: &str) -> Result<Option<ArticleAi>, sqlx::Error> {
        let row = sqlx::query("SELECT articles.id, article_ai.status, model, generated_at, error, overview_json, kb_json, images_json FROM articles LEFT JOIN article_ai ON article_ai.article_id = articles.id WHERE articles.id = $1 AND articles.status = 'fetched'")
            .bind(id).fetch_optional(self.pool()).await?;
        let Some(row) = row else { return Ok(None) };
        let status: Option<String> = row.try_get("status")?;
        let status = match status.as_deref() {
            Some("ready") => "ready",
            Some("failed") => "failed",
            _ => "pending",
        };
        let ready = status == "ready";
        let overview: Option<Value> = row.try_get("overview_json")?;
        let kb: Option<Value> = row.try_get("kb_json")?;
        let images: Option<Value> = row.try_get("images_json")?;
        let generated_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("generated_at")?;
        Ok(Some(ArticleAi {
            article_id: id.into(),
            status: status.into(),
            overview: ready
                .then(|| parse_overview(overview.as_ref().unwrap_or(&Value::Null)))
                .flatten(),
            kb: ready
                .then(|| parse_kb(kb.as_ref().unwrap_or(&Value::Null)))
                .flatten(),
            images: if ready {
                parse_images(images.as_ref().unwrap_or(&Value::Null))
            } else {
                vec![]
            },
            model: row.try_get("model")?,
            generated_at: generated_at
                .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            error: row.try_get("error")?,
        }))
    }
}

fn decoded(v: &Value) -> Value {
    if let Some(s) = v.as_str() {
        serde_json::from_str(s).unwrap_or(Value::Null)
    } else {
        v.clone()
    }
}
fn strings(v: &Value) -> Value {
    Value::Array(
        v.as_array()
            .into_iter()
            .flatten()
            .filter(|v| v.is_string())
            .cloned()
            .collect(),
    )
}
/// Field defaults: required string -> ""; nullable string -> null; arrays -> [].
fn object(v: &Value, required: &[&str], nullable: &[&str], arrays: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for &key in required {
        out.insert(key.into(), json!(v[key].as_str().unwrap_or("")));
    }
    for &key in nullable {
        out.insert(
            key.into(),
            v[key]
                .as_str()
                .filter(|s| !s.is_empty())
                .map_or(Value::Null, |s| json!(s)),
        );
    }
    for &key in arrays {
        out.insert(key.into(), strings(&v[key]));
    }
    Value::Object(out)
}
fn objects(v: &Value, required: &[&str], nullable: &[&str]) -> Value {
    Value::Array(
        v.as_array()
            .into_iter()
            .flatten()
            .filter(|v| v.is_object())
            .map(|v| object(v, required, nullable, &[]))
            .collect(),
    )
}
pub fn parse_overview(v: &Value) -> Option<Value> {
    let v = decoded(v);
    if !v.is_object() {
        return None;
    }
    let mut out = object(
        &v,
        &["genre", "tldr", "summary"],
        &["appliesWhen", "readingGuide"],
        &["keyPoints", "package", "caveats"],
    );
    out["maturity"] = object(&v["maturity"], &["status"], &["evidence"], &[]);
    let mut extras = object(
        &v["extras"],
        &[],
        &["thesis"],
        &["quickStart", "portingChecklist", "compat", "actions"],
    );
    extras["lessons"] = objects(
        &v["extras"]["lessons"],
        &["constraint", "decision"],
        &["outcome", "transferable"],
    );
    extras["arguments"] = objects(&v["extras"]["arguments"], &["claim"], &["evidence"]);
    out["extras"] = extras;
    out["faq"] = objects(&v["faq"], &["question", "answer"], &["source"]);
    Some(out)
}
pub fn parse_kb(v: &Value) -> Option<Value> {
    let v = decoded(v);
    if !v.is_object() {
        return None;
    }
    let mut out = object(
        &v,
        &[],
        &["problem", "approach", "cost"],
        &[
            "domain",
            "robotTypes",
            "interfaces",
            "toolchain",
            "pitfalls",
            "entities",
            "openQuestions",
            "searchKeywords",
        ],
    );
    for (key, required, nullable) in [
        (
            "components",
            &["name"][..],
            &["kind", "spec", "role", "source"][..],
        ),
        (
            "parameters",
            &["name", "value"][..],
            &["unit", "context", "source"][..],
        ),
        (
            "designDecisions",
            &["decision"][..],
            &["alternatives", "rationale", "source"][..],
        ),
        ("references", &["title"][..], &["url", "relation"][..]),
        ("claims", &["claim"][..], &["evidence", "source"][..]),
    ] {
        out[key] = objects(&v[key], required, nullable);
    }
    Some(out)
}
pub fn parse_images(v: &Value) -> Vec<Value> {
    let v = decoded(v);
    v.as_array()
        .into_iter()
        .flatten()
        .filter(|v| v.is_object())
        .map(|v| {
            let mut out = object(v, &["caption"], &["kind", "textInImage"], &["facts"]);
            // Zod accepts only safe integral numbers, including 0.0 JSON values.
            let index = v["index"]
                .as_f64()
                .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
                .unwrap_or(0.0) as i64;
            out["index"] = json!(index);
            out
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lenient_blobs_keep_the_existing_shape() {
        assert!(parse_overview(&json!("broken")).is_none());
        assert!(parse_kb(&json!([])).is_none());
        let overview = parse_overview(&json!({"keyPoints": [1, "ok"], "extras": {"lessons": [null, {"constraint": 3}]}, "maturity": false})).unwrap();
        assert_eq!(overview["keyPoints"], json!(["ok"]));
        assert_eq!(
            overview["extras"]["lessons"],
            json!([{"constraint":"","decision":"","outcome":null,"transferable":null}])
        );
        assert_eq!(overview["maturity"], json!({"status":"","evidence":null}));
        assert_eq!(
            parse_images(&json!([null, {"index": 2.0}, {"index": 1.5}]))[0]["index"],
            2
        );
    }
}
