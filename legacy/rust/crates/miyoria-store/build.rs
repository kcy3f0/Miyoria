//! Rebuilds the crate when migrations change, since they are embedded.

fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
