//! Token counts and speeds read from a response as it passes through.
//!
//! Siphon puts llama.cpp-style `timings` in every generation response: at the top level of a
//! plain body, and in a late event of a stream (a chat chunk, the Messages `message_delta`,
//! or the `response` of the last Responses event). Other servers report only `usage`, in
//! OpenAI's, Anthropic's or the Responses API's shape. `timings` wins where both are present.

use serde_json::Value;

/// The most response bytes kept to parse a body that is not streamed.
const PARSE_LIMIT: usize = 32 << 20;
/// The longest SSE line parsed.
const LINE_LIMIT: usize = 4 << 20;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    /// The whole prompt, including tokens read from the prefix cache.
    pub prompt_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub ttft_ms: Option<f64>,
    pub decode_tps: Option<f64>,
    pub tokens_per_round: Option<f64>,
    /// The error a body or event reported, even under a 200: Siphon answers a reply that is
    /// not streamed with 200 before its body is ready, so a later failure arrives as an error
    /// object in the body.
    pub error: Option<String>,
}

/// The message of an error object in OpenAI's, Anthropic's or the Responses API's shape.
fn error_of(value: &Value) -> Option<String> {
    let error = match value["type"].as_str() {
        Some("response.failed") => &value["response"]["error"],
        _ => &value["error"],
    };
    if error.is_null() {
        return None;
    }
    let message = error["message"]
        .as_str()
        .or(error.as_str())
        .unwrap_or("error");
    Some(message.chars().take(300).collect())
}

fn int(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().map(|f| f as i64))
}

impl Stats {
    fn timings(&mut self, t: &Value) {
        if !t.is_object() {
            return;
        }
        let cached = int(&t["cache_n"]);
        if let Some(prefilled) = int(&t["prompt_n"]) {
            self.prompt_tokens = Some(prefilled + cached.unwrap_or(0));
        }
        self.cached_tokens = cached.or(self.cached_tokens);
        self.output_tokens = int(&t["predicted_n"]).or(self.output_tokens);
        self.ttft_ms = t["ttft_ms"].as_f64().or(self.ttft_ms);
        self.decode_tps = t["predicted_per_second"].as_f64().or(self.decode_tps);
        self.tokens_per_round = t["tokens_per_round"].as_f64().or(self.tokens_per_round);
    }

    fn usage(&mut self, u: &Value) {
        if !u.is_object() {
            return;
        }
        let (prompt, cached, output) = if u.get("cache_read_input_tokens").is_some() {
            // Anthropic: input_tokens leaves out the tokens read from the cache.
            let cached = int(&u["cache_read_input_tokens"]);
            let prompt = int(&u["input_tokens"]).map(|n| n + cached.unwrap_or(0));
            (prompt, cached, int(&u["output_tokens"]))
        } else if u.get("input_tokens").is_some() {
            // Responses API: input_tokens counts the whole prompt.
            (
                int(&u["input_tokens"]),
                int(&u["input_tokens_details"]["cached_tokens"]),
                int(&u["output_tokens"]),
            )
        } else {
            (
                int(&u["prompt_tokens"]),
                int(&u["prompt_tokens_details"]["cached_tokens"]),
                int(&u["completion_tokens"]),
            )
        };
        self.prompt_tokens = self.prompt_tokens.or(prompt);
        self.cached_tokens = self.cached_tokens.or(cached);
        // A Messages stream reports output tokens again, and finally, in `message_delta`.
        self.output_tokens = output.or(self.output_tokens);
    }

    /// Reads one JSON value: a whole body or one event's data.
    pub fn read(&mut self, value: &Value) {
        let mut timings = Vec::new();
        let mut usages = Vec::new();
        for holder in [value, &value["response"], &value["message"]] {
            timings.push(&holder["timings"]);
            usages.push(&holder["usage"]);
        }
        if self.error.is_none() {
            self.error = error_of(value);
        }
        // Usage first, so that timings, which Siphon computes from the same counts, win.
        for u in usages {
            self.usage(u);
        }
        for t in timings {
            self.timings(t);
        }
    }
}

/// Watches a response's bytes and keeps what it learns.
pub struct Meter {
    sse: bool,
    buffer: Vec<u8>,
    overflow: bool,
    pub stats: Stats,
}

impl Meter {
    pub fn new(content_type: Option<&str>) -> Self {
        Self {
            sse: content_type.is_some_and(|t| t.starts_with("text/event-stream")),
            buffer: Vec::new(),
            overflow: false,
            stats: Stats::default(),
        }
    }

    pub fn streamed(&self) -> bool {
        self.sse
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        if !self.sse {
            if self.buffer.len() + chunk.len() > PARSE_LIMIT {
                self.overflow = true;
                self.buffer = Vec::new();
            }
            if !self.overflow {
                self.buffer.extend_from_slice(chunk);
            }
            return;
        }
        for &byte in chunk {
            if byte == b'\n' {
                let line = std::mem::take(&mut self.buffer);
                if !self.overflow {
                    self.line(&line);
                }
                self.overflow = false;
            } else if self.buffer.len() < LINE_LIMIT {
                self.buffer.push(byte);
            } else {
                self.overflow = true;
                self.buffer.clear();
            }
        }
    }

    fn line(&mut self, line: &[u8]) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let Some(data) = line.strip_prefix(b"data:") else {
            return;
        };
        let data = data.strip_prefix(b" ").unwrap_or(data);
        if data.first() != Some(&b'{') {
            return;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(data) {
            self.stats.read(&value);
        }
    }

    /// The stats after the last chunk.
    pub fn finish(mut self) -> Stats {
        if self.sse {
            if !self.buffer.is_empty() && !self.overflow {
                let line = std::mem::take(&mut self.buffer);
                self.line(&line);
            }
        } else if !self.overflow
            && let Ok(value) = serde_json::from_slice::<Value>(&self.buffer)
        {
            self.stats.read(&value);
        }
        self.stats
    }
}

/// The reasoning effort a request asks for, in any of the three APIs' fields.
pub fn effort(request: &Value) -> Option<String> {
    let named = |v: &Value| v.as_str().map(str::to_owned);
    named(&request["reasoning_effort"])
        .or_else(|| named(&request["reasoning"]["effort"]))
        .or_else(|| named(&request["output_config"]["effort"]))
        .or_else(|| (request["thinking"]["type"] == "disabled").then(|| "none".to_owned()))
        .map(|e| e.chars().take(16).collect())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn stream(meter: &mut Meter, events: &[Value]) {
        let mut text = String::from(": keep-alive\n\n");
        for event in events {
            text.push_str(&format!("event: x\ndata: {event}\n\n"));
        }
        text.push_str("data: [DONE]\n\n");
        // Split mid-line to check that lines are reassembled.
        let bytes = text.as_bytes();
        for chunk in bytes.chunks(7) {
            meter.feed(chunk);
        }
    }

    const TIMINGS: &str = r#"{"cache_n":30,"prompt_n":70,"predicted_n":12,"ttft_ms":250.5,"predicted_per_second":180.25,"tokens_per_round":3.5}"#;

    fn expected() -> Stats {
        Stats {
            prompt_tokens: Some(100),
            cached_tokens: Some(30),
            output_tokens: Some(12),
            ttft_ms: Some(250.5),
            decode_tps: Some(180.25),
            tokens_per_round: Some(3.5),
            error: None,
        }
    }

    #[test]
    fn plain_chat_body() {
        let timings: Value = serde_json::from_str(TIMINGS).unwrap();
        let body = json!({"usage": {"prompt_tokens": 100, "completion_tokens": 12,
            "prompt_tokens_details": {"cached_tokens": 30}}, "timings": timings});
        let mut meter = Meter::new(Some("application/json"));
        meter.feed(body.to_string().as_bytes());
        assert!(!meter.streamed());
        assert_eq!(meter.finish(), expected());
    }

    #[test]
    fn chat_stream_with_late_timings() {
        let timings: Value = serde_json::from_str(TIMINGS).unwrap();
        let mut meter = Meter::new(Some("text/event-stream"));
        stream(
            &mut meter,
            &[
                json!({"choices": [{"delta": {"content": "hi"}}]}),
                json!({"choices": [{"finish_reason": "stop"}], "timings": timings}),
            ],
        );
        assert_eq!(meter.finish(), expected());
    }

    #[test]
    fn messages_stream() {
        let timings: Value = serde_json::from_str(TIMINGS).unwrap();
        let mut meter = Meter::new(Some("text/event-stream; charset=utf-8"));
        stream(
            &mut meter,
            &[
                json!({"type": "message_start", "message": {"usage": {"input_tokens": 70,
                    "cache_read_input_tokens": 30, "output_tokens": 1}}}),
                json!({"type": "message_delta", "usage": {"output_tokens": 12}, "timings": timings}),
            ],
        );
        assert_eq!(meter.finish(), expected());
    }

    #[test]
    fn responses_stream() {
        let timings: Value = serde_json::from_str(TIMINGS).unwrap();
        let mut meter = Meter::new(Some("text/event-stream"));
        stream(
            &mut meter,
            &[
                json!({"type": "response.completed", "response": {"usage": {"input_tokens": 100,
                "input_tokens_details": {"cached_tokens": 30}, "output_tokens": 12},
                "timings": timings}}),
            ],
        );
        assert_eq!(meter.finish(), expected());
    }

    #[test]
    fn usage_without_timings() {
        let mut meter = Meter::new(Some("application/json"));
        meter.feed(
            json!({"usage": {"input_tokens": 5, "cache_read_input_tokens": 2, "output_tokens": 3}})
                .to_string()
                .as_bytes(),
        );
        let stats = meter.finish();
        assert_eq!(
            (
                stats.prompt_tokens,
                stats.cached_tokens,
                stats.output_tokens
            ),
            (Some(7), Some(2), Some(3))
        );
        assert_eq!(stats.ttft_ms, None);
    }

    #[test]
    fn count_tokens_and_tokenize_are_not_usage() {
        let mut meter = Meter::new(Some("application/json"));
        meter.feed(br#"{"input_tokens": 42}"#);
        assert_eq!(meter.finish(), Stats::default());
    }

    #[test]
    fn leading_whitespace_before_a_padded_body() {
        let timings: Value = serde_json::from_str(TIMINGS).unwrap();
        let mut meter = Meter::new(Some("application/json"));
        for _ in 0..5 {
            meter.feed(b" ");
        }
        meter.feed(json!({"timings": timings}).to_string().as_bytes());
        assert_eq!(meter.finish(), expected());
    }

    #[test]
    fn error_bodies_under_200() {
        for (body, message) in [
            (
                json!({"error": {"message": "engine failed", "type": "api_error"}}),
                "engine failed",
            ),
            (
                json!({"type": "error", "error": {"type": "api_error", "message": "boom"}}),
                "boom",
            ),
        ] {
            let mut meter = Meter::new(Some("application/json"));
            meter.feed(format!("   {body}").as_bytes());
            assert_eq!(meter.finish().error.as_deref(), Some(message));
        }
        let mut meter = Meter::new(Some("application/json"));
        meter.feed(br#"{"object": "response", "status": "completed", "error": null}"#);
        assert_eq!(meter.finish().error, None);
        let mut meter = Meter::new(Some("text/event-stream"));
        stream(
            &mut meter,
            &[
                json!({"type": "response.failed", "response": {"error": {"message": "out of memory"}}}),
            ],
        );
        assert_eq!(meter.finish().error.as_deref(), Some("out of memory"));
    }

    #[test]
    fn efforts() {
        assert_eq!(
            effort(&json!({"reasoning_effort": "high"})).as_deref(),
            Some("high")
        );
        assert_eq!(
            effort(&json!({"reasoning": {"effort": "low"}})).as_deref(),
            Some("low")
        );
        assert_eq!(
            effort(&json!({"output_config": {"effort": "max"}})).as_deref(),
            Some("max")
        );
        assert_eq!(
            effort(&json!({"thinking": {"type": "disabled"}})).as_deref(),
            Some("none")
        );
        assert_eq!(effort(&json!({})), None);
    }
}
