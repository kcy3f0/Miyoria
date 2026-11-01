//! Consistent terminal output: colored ✓ / ✗ / ! marks.

use std::fmt::Display;
use std::io::IsTerminal;
use std::sync::OnceLock;

fn color() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal())
}

fn paint(code: &str, s: impl Display) -> String {
    if color() {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

pub fn green(s: impl Display) -> String {
    paint("32", s)
}

pub fn red(s: impl Display) -> String {
    paint("31", s)
}

pub fn yellow(s: impl Display) -> String {
    paint("33", s)
}

pub fn dim(s: impl Display) -> String {
    paint("90", s)
}

pub fn bold(s: impl Display) -> String {
    paint("1", s)
}

pub fn cyan(s: impl Display) -> String {
    paint("36", s)
}

pub fn ok(msg: impl Display) {
    println!("{} {msg}", green("✓"));
}

pub fn fail(msg: impl Display) {
    eprintln!("{} {msg}", red("✗"));
}

pub fn warn(msg: impl Display) {
    println!("{} {msg}", yellow("!"));
}

pub fn note(msg: impl Display) {
    println!("{} {msg}", dim("·"));
}

pub fn section(title: impl Display) {
    println!("\n{}", bold(cyan(title)));
}
