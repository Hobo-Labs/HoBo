// Generated sketch from a reverse-extracted hobo:sdk surface.
// This is an idiom-layer starting point, not a contract definition.

pub struct BindleBuilder {
    declarations: Vec<DeclarationFact>,
}

pub enum DeclarationFact {
    Resource { kind: &'static str, name: &'static str },
    Allow { name: &'static str, verbs: Vec<&'static str>, provenance: &'static str },
    Bind { from: &'static str, to: &'static str },
    ProviderOption { name: &'static str, provider: &'static str, option: &'static str },
    Handler { resource: &'static str, event: &'static str, export_name: &'static str },
    RuntimeStep { name: &'static str, signature: &'static str },
}

impl BindleBuilder {
    pub fn kv(mut self, name: &'static str) -> Self {
        self.declarations.push(DeclarationFact::Resource { kind: "kv", name });
        self
    }

    pub fn allow(mut self, name: &'static str, verbs: Vec<&'static str>) -> Self {
        self.declarations.push(DeclarationFact::Allow {
            name,
            verbs,
            provenance: "declared-narrow-or-equal",
        });
        self
    }

    pub fn bind(mut self, from: &'static str, to: &'static str) -> Self {
        self.declarations.push(DeclarationFact::Bind { from, to });
        self
    }

    pub fn collect(self, sink: &mut dyn HoboSdkLoweringSink) -> Result<(), LoweringError> {
        for declaration in self.declarations {
            sink.lower(declaration)?;
        }
        Ok(())
    }
}

pub trait HoboSdkLoweringSink {
    fn lower(&mut self, declaration: DeclarationFact) -> Result<(), LoweringError>;
}

pub struct LoweringError;
