//! Logging levels. A request is logged as `metadata` or `full`; `full` also stores its
//! bodies. The level comes from the owner's override, else the model's default, else
//! `metadata`.

use std::{collections::HashMap, sync::RwLock};

use serde::Serialize;

pub const METADATA: &str = "metadata";
pub const FULL: &str = "full";

pub fn parse(raw: &str) -> Option<&'static str> {
    match raw {
        METADATA => Some(METADATA),
        FULL => Some(FULL),
        _ => None,
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Overrides {
    pub users: HashMap<String, &'static str>,
    pub models: HashMap<String, &'static str>,
}

impl Overrides {
    pub fn level(&self, sub: &str, model: Option<&str>) -> &'static str {
        self.users
            .get(sub)
            .or_else(|| model.and_then(|m| self.models.get(m)))
            .copied()
            .unwrap_or(METADATA)
    }
}

#[derive(Default)]
pub struct Levels(RwLock<Overrides>);

impl Levels {
    pub fn load(&self, rows: Vec<(String, String, String)>) {
        let mut overrides = Overrides::default();
        for (scope, subject, level) in rows {
            let Some(level) = parse(&level) else { continue };
            match scope.as_str() {
                "user" => overrides.users.insert(subject, level),
                "model" => overrides.models.insert(subject, level),
                _ => None,
            };
        }
        *self.0.write().unwrap() = overrides;
    }

    pub fn get(&self) -> Overrides {
        self.0.read().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_then_model_then_metadata() {
        let levels = Levels::default();
        levels.load(vec![
            ("model".into(), "m".into(), "full".into()),
            ("user".into(), "alice".into(), "metadata".into()),
            ("user".into(), "bob".into(), "full".into()),
        ]);
        let o = levels.get();
        assert_eq!(o.level("alice", Some("m")), METADATA);
        assert_eq!(o.level("carol", Some("m")), FULL);
        assert_eq!(o.level("carol", Some("other")), METADATA);
        assert_eq!(o.level("bob", None), FULL);
    }
}
