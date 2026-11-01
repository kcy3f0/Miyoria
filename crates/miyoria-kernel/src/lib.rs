//! The Miyoria kernel.
//!
//! Every feature is a [`Module`]. The [`Supervisor`] starts modules in
//! dependency order, restarts them when they fail and lets them be enabled or
//! disabled at runtime. Modules only talk to each other through the
//! [`EventBus`] and the [`ServiceRegistry`], both reached via [`ModuleContext`].

pub mod bus;
pub mod config;
pub mod context;
pub mod module;
pub mod services;
pub mod supervisor;

pub use bus::{EventBus, Subscription, TopicFilter};
pub use config::{Config, ConfigError};
pub use context::ModuleContext;
pub use module::{Health, Module, ModuleManifest};
pub use services::ServiceRegistry;
pub use supervisor::{ModuleStatus, Supervisor, SupervisorHandle};
