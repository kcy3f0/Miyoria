//! Interactive questions behind a trait, so setup flows can run against
//! scripted answers in tests.

use inquire::validator::Validation;
use inquire::{Confirm, InquireError, MultiSelect, Password, PasswordDisplayMode, Select, Text};

use crate::validate::Check;

pub trait Prompter {
    /// Free text; Enter on an empty line returns `default`.
    fn text(&mut self, msg: &str, default: &str, check: Option<Check>) -> anyhow::Result<String>;
    /// Hidden input; an empty string means "nothing typed".
    fn secret(&mut self, msg: &str) -> anyhow::Result<String>;
    fn select(&mut self, msg: &str, options: &[String], default: usize) -> anyhow::Result<usize>;
    fn multi_select(
        &mut self,
        msg: &str,
        options: &[String],
        defaults: &[usize],
    ) -> anyhow::Result<Vec<usize>>;
    fn confirm(&mut self, msg: &str, default: bool) -> anyhow::Result<bool>;
}

/// Esc: leave the current question / area.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("已取消")
    }
}

impl std::error::Error for Cancelled {}

/// Ctrl+C: stop the whole command.
#[derive(Debug)]
pub struct Interrupted;

impl std::fmt::Display for Interrupted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("已中斷")
    }
}

impl std::error::Error for Interrupted {}

pub fn is_cancelled(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Cancelled>().is_some()
}

pub fn is_interrupted(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Interrupted>().is_some()
}

fn map_err(e: InquireError) -> anyhow::Error {
    match e {
        InquireError::OperationCanceled => Cancelled.into(),
        InquireError::OperationInterrupted => Interrupted.into(),
        InquireError::NotTTY => anyhow::anyhow!(
            "這個指令需要互動式終端機;在腳本裡請改用 `miyoria config set <key> <value>`"
        ),
        e => e.into(),
    }
}

/// Fails early (instead of hanging) when stdin / stdout are not a terminal.
pub fn require_tty() -> anyhow::Result<()> {
    use std::io::IsTerminal;
    if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
        Ok(())
    } else {
        Err(map_err(InquireError::NotTTY))
    }
}

/// The real terminal.
pub struct Inquire;

impl Prompter for Inquire {
    fn text(&mut self, msg: &str, default: &str, check: Option<Check>) -> anyhow::Result<String> {
        let mut t = Text::new(msg);
        if !default.is_empty() {
            t = t
                .with_default(default)
                .with_help_message("Enter 保留目前的值");
        }
        if let Some(check) = check {
            t = t.with_validator(move |s: &str| {
                Ok(match check(s) {
                    Ok(()) => Validation::Valid,
                    Err(e) => Validation::Invalid(e.into()),
                })
            });
        }
        t.prompt().map_err(map_err)
    }

    fn secret(&mut self, msg: &str) -> anyhow::Result<String> {
        Password::new(msg)
            .without_confirmation()
            .with_display_mode(PasswordDisplayMode::Masked)
            .prompt()
            .map_err(map_err)
    }

    fn select(&mut self, msg: &str, options: &[String], default: usize) -> anyhow::Result<usize> {
        Select::new(msg, options.to_vec())
            .with_starting_cursor(default.min(options.len().saturating_sub(1)))
            .with_page_size(12)
            .with_help_message("↑↓ 移動,Enter 選擇,打字可篩選,Esc 返回")
            .raw_prompt()
            .map(|o| o.index)
            .map_err(map_err)
    }

    fn multi_select(
        &mut self,
        msg: &str,
        options: &[String],
        defaults: &[usize],
    ) -> anyhow::Result<Vec<usize>> {
        MultiSelect::new(msg, options.to_vec())
            .with_default(defaults)
            .with_page_size(15)
            .with_help_message("↑↓ 移動,空白鍵勾選,Enter 確認,Esc 返回")
            .raw_prompt()
            .map(|v| v.into_iter().map(|o| o.index).collect())
            .map_err(map_err)
    }

    fn confirm(&mut self, msg: &str, default: bool) -> anyhow::Result<bool> {
        Confirm::new(msg)
            .with_default(default)
            .prompt()
            .map_err(map_err)
    }
}

#[cfg(test)]
pub mod scripted {
    use std::collections::VecDeque;

    use super::*;

    #[derive(Debug)]
    pub enum Answer {
        /// Accept the default (Enter).
        Enter,
        Text(&'static str),
        Pick(usize),
        Picks(Vec<usize>),
        Yes,
        No,
    }

    /// Answers questions from a script and records what was asked.
    #[derive(Default)]
    pub struct Scripted {
        answers: VecDeque<Answer>,
        pub asked: Vec<String>,
    }

    impl Scripted {
        pub fn new(answers: impl IntoIterator<Item = Answer>) -> Self {
            Self {
                answers: answers.into_iter().collect(),
                asked: Vec::new(),
            }
        }

        pub fn done(&self) -> bool {
            self.answers.is_empty()
        }

        fn next(&mut self, msg: &str) -> Answer {
            self.asked.push(msg.to_owned());
            self.answers
                .pop_front()
                .unwrap_or_else(|| panic!("no scripted answer for {msg:?}; asked {:?}", self.asked))
        }
    }

    impl Prompter for Scripted {
        fn text(
            &mut self,
            msg: &str,
            default: &str,
            check: Option<Check>,
        ) -> anyhow::Result<String> {
            let answer = match self.next(msg) {
                Answer::Enter => default.to_owned(),
                Answer::Text(s) => s.to_owned(),
                other => panic!("{msg:?} expects text, got {other:?}"),
            };
            if let Some(check) = check
                && let Err(e) = check(&answer)
            {
                panic!("{msg:?}: {answer:?} rejected: {e}");
            }
            Ok(answer)
        }

        fn secret(&mut self, msg: &str) -> anyhow::Result<String> {
            match self.next(msg) {
                Answer::Enter => Ok(String::new()),
                Answer::Text(s) => Ok(s.to_owned()),
                other => panic!("{msg:?} expects a secret, got {other:?}"),
            }
        }

        fn select(
            &mut self,
            msg: &str,
            options: &[String],
            default: usize,
        ) -> anyhow::Result<usize> {
            match self.next(msg) {
                Answer::Enter => Ok(default),
                Answer::Pick(i) => {
                    assert!(i < options.len(), "{msg:?}: no option {i} in {options:?}");
                    Ok(i)
                }
                other => panic!("{msg:?} expects a choice, got {other:?}"),
            }
        }

        fn multi_select(
            &mut self,
            msg: &str,
            _options: &[String],
            defaults: &[usize],
        ) -> anyhow::Result<Vec<usize>> {
            match self.next(msg) {
                Answer::Enter => Ok(defaults.to_vec()),
                Answer::Picks(v) => Ok(v),
                other => panic!("{msg:?} expects choices, got {other:?}"),
            }
        }

        fn confirm(&mut self, msg: &str, default: bool) -> anyhow::Result<bool> {
            match self.next(msg) {
                Answer::Enter => Ok(default),
                Answer::Yes => Ok(true),
                Answer::No => Ok(false),
                other => panic!("{msg:?} expects yes/no, got {other:?}"),
            }
        }
    }
}
