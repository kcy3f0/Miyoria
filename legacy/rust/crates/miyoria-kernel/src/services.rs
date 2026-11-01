use std::any::{Any, TypeId, type_name};
use std::collections::HashMap;
use std::sync::Arc;

use miyoria_types::ModuleId;
use parking_lot::RwLock;

struct Entry {
    owner: ModuleId,
    value: Arc<dyn Any + Send + Sync>,
}

/// Type-keyed registry of service handles. Modules provide implementations of
/// shared traits (usually `dyn SomeTrait`) and other modules look them up.
/// Services are removed automatically when their owning module stops.
#[derive(Default)]
pub struct ServiceRegistry {
    entries: RwLock<HashMap<TypeId, Entry>>,
}

impl ServiceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `service` as the implementation of `T`, replacing any previous one.
    pub fn provide<T>(&self, owner: &ModuleId, service: Arc<T>)
    where
        T: ?Sized + Send + Sync + 'static,
    {
        self.entries.write().insert(
            TypeId::of::<Arc<T>>(),
            Entry {
                owner: owner.clone(),
                value: Arc::new(service),
            },
        );
    }

    pub fn get<T>(&self) -> Option<Arc<T>>
    where
        T: ?Sized + Send + Sync + 'static,
    {
        self.entries
            .read()
            .get(&TypeId::of::<Arc<T>>())
            .and_then(|e| e.value.downcast_ref::<Arc<T>>().cloned())
    }

    pub fn require<T>(&self) -> anyhow::Result<Arc<T>>
    where
        T: ?Sized + Send + Sync + 'static,
    {
        self.get::<T>()
            .ok_or_else(|| anyhow::anyhow!("service `{}` is not available", type_name::<T>()))
    }

    pub fn remove_owned_by(&self, owner: &ModuleId) {
        self.entries.write().retain(|_, e| &e.owner != owner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    trait Greeter: Send + Sync {
        fn greet(&self) -> String;
    }

    struct Hi;
    impl Greeter for Hi {
        fn greet(&self) -> String {
            "hi".to_owned()
        }
    }

    #[test]
    fn provide_get_remove() {
        let reg = ServiceRegistry::new();
        let owner = ModuleId::from("m");
        assert!(reg.get::<dyn Greeter>().is_none());
        reg.provide::<dyn Greeter>(&owner, Arc::new(Hi));
        assert_eq!(reg.require::<dyn Greeter>().unwrap().greet(), "hi");
        reg.remove_owned_by(&owner);
        assert!(reg.get::<dyn Greeter>().is_none());
    }
}
