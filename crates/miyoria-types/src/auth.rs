use crate::platform::AccountRef;

/// Answers "may this account use this permission node?". Provided as a
/// `dyn Authorizer` service by the module that owns permissions (currently
/// `commands`). Used e.g. to check tools against the user who triggered a turn.
pub trait Authorizer: Send + Sync {
    fn allows(&self, account: &AccountRef, node: &str) -> bool;
}
