//! Development-only fixture driver; never included in a serving image.
use herkules_bbs::crawl::{
    self, content,
    corpus::Corpus,
    guard::{Guard, Policy, Priority},
    source,
    worker::{Forum, ONCE, Worker},
};
use serde_json::{Value, json};
use std::io::{self, BufRead};
struct Fixture {
    pages: Vec<Value>,
    posts: Value,
    total: usize,
    backfill_fails: bool,
}
impl Forum for Fixture {
    async fn list(&self, page: i32, size: i32, _: Priority) -> crawl::Result<source::Listing> {
        if page > 1 && self.backfill_fails {
            return Err(crawl::Error::Source {
                kind: "serverError",
                message: "http 503".into(),
                retry: None,
            });
        }
        source::parse_listing(
            json!({"success":true,"data":{"total":self.total,"list":self.pages.get((page-1) as usize).cloned().unwrap_or(json!([]))}}),
            page,
            size,
        )
    }
    async fn detail(&self, id: &str, _: Priority) -> crawl::Result<source::Detail> {
        source::parse_detail(
            json!({"success":true,"data":self.posts.get(id).cloned().unwrap_or(Value::Null)}),
        )
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line?)?;
        let out = match v["op"].as_str().unwrap_or("") {
            "derive" => {
                let format = v["format"].as_str().unwrap();
                let raw = v["raw"].as_str().unwrap();
                let base = v["baseUrl"].as_str().unwrap();
                let title = v["title"].as_str().unwrap_or("Title");
                let extracted = content::extract(format, raw, base);
                json!({"extracted":extracted,"html":content::render_html(format,raw,base,title,&extracted.links)})
            }
            "detail" => serde_json::to_value(source::parse_detail(v["json"].clone())?)?,
            "cycle" | "discover" | "store" | "next" | "guard" => {
                let pool = sqlx::postgres::PgPoolOptions::new()
                    .max_connections(3)
                    .connect(v["database"].as_str().unwrap())
                    .await?;
                let corpus = Corpus { pool: pool.clone() };
                let out = match v["op"].as_str().unwrap() {
                    "guard" => {
                        let guard = Guard::load(pool.clone(), Policy::default()).await?;
                        let result = guard.acquire().await;
                        let out = match result {
                            Ok(()) => json!("acquired"),
                            Err(e) => json!({"error":e.to_string()}),
                        };
                        if v["settle"].as_bool().unwrap_or(false) {
                            guard
                                .settle(Some(("forbidden", None, "forbidden (http 403)")))
                                .await?;
                        }
                        out
                    }
                    "cycle" => {
                        let _lock = crawl::corpus::lock(v["database"].as_str().unwrap()).await?;
                        corpus.boot().await?;
                        // Limits disabled only in this fixture executable. Production CLI is fixed-policy.
                        let guard = Guard::load(
                            pool.clone(),
                            Policy {
                                spacing: 0,
                                jitter: 0,
                                minute: u64::MAX,
                                day: u64::MAX,
                                reserve: 0,
                                max_wait: i64::MAX,
                                cooldown_max: 0,
                            },
                        )
                        .await?;
                        let worker = Worker {
                            corpus,
                            source: Fixture {
                                pages: serde_json::from_value(v["pages"].clone())?,
                                posts: v["posts"].clone(),
                                total: v["total"].as_u64().unwrap() as usize,
                                backfill_fails: v["backfillFails"].as_bool().unwrap_or(false),
                            },
                            guard,
                        };
                        serde_json::to_value(worker.cycle("manual", ONCE).await?)?
                    }
                    "discover" => {
                        let listing = source::parse_listing(v["json"].clone(), 1, 20)?;
                        json!(corpus.discover(&listing.items).await?)
                    }
                    "store" => {
                        let detail = source::parse_detail(v["json"].clone())?;
                        match corpus.store(v["id"].as_str().unwrap(), &detail).await {
                            Ok(changed) => json!(changed),
                            Err(e) => json!({"error":e.to_string()}),
                        }
                    }
                    _ => json!(format!("{:?}", corpus.next(true, true, true).await?)),
                };
                pool.close().await;
                out
            }
            _ => panic!("unknown probe operation"),
        };
        println!("{}", out);
    }
    Ok(())
}
