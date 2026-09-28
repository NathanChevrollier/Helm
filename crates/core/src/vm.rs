//! Machines virtuelles KVM/QEMU via libvirt (`virsh` sur le serveur), avec repli sur sudo quand
//! l'utilisateur SSH n'appartient pas au groupe `libvirt`. Une VM est toujours désignée par son
//! UUID dans les commandes : son nom peut contenir n'importe quel caractère.

use serde::Serialize;

use crate::{Connection, Error, ExecOutput, Result};

/// Préfixe de toutes les commandes : sortie en anglais stable et connexion système (la session
/// utilisateur `qemu:///session` montrerait d'autres VM).
const VIRSH: &str = "LC_ALL=C virsh -c qemu:///system";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    Direct,
    Sudo,
    Unavailable,
}

pub async fn access(conn: &Connection, sudo: Option<&str>) -> Result<(Access, String)> {
    let probe = format!("{VIRSH} version --daemon 2>&1 | sed -n 's/^Running against daemon: //p'");
    let direct = conn.exec(&format!("{VIRSH} list --name >/dev/null && {probe}"), None).await?;
    if direct.success() {
        return Ok((Access::Direct, direct.stdout.trim().to_string()));
    }
    if !conn.exec("command -v virsh", None).await?.success() {
        return Ok((Access::Unavailable, "libvirt (virsh) n'est pas installé sur ce serveur".into()));
    }
    let via_sudo = match conn.exec_sudo(&format!("{VIRSH} list --name >/dev/null && {probe}"), sudo, None).await {
        Ok(o) => o,
        Err(Error::Other(reason)) => return Ok((Access::Unavailable, reason)),
        Err(e) => return Err(e),
    };
    if via_sudo.success() {
        return Ok((Access::Sudo, via_sudo.stdout.trim().to_string()));
    }
    Ok((Access::Unavailable, direct.stderr.trim().to_string()))
}

pub async fn run(conn: &Connection, access: Access, sudo: Option<&str>, args: &str) -> Result<ExecOutput> {
    let cmd = format!("{VIRSH} {args}");
    match access {
        Access::Direct => conn.exec(&cmd, None).await,
        Access::Sudo => conn.exec_sudo(&cmd, sudo, None).await,
        Access::Unavailable => Err(Error::Other("libvirt n'est pas accessible sur ce serveur".into())),
    }
}

pub fn valid_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VmState {
    Running,
    Paused,
    ShutOff,
    Shutdown,
    Crashed,
    Suspended,
    Other,
}

impl VmState {
    pub fn parse(s: &str) -> Self {
        match s.trim() {
            "running" | "idle" => Self::Running,
            "paused" => Self::Paused,
            "shut off" => Self::ShutOff,
            "in shutdown" => Self::Shutdown,
            "crashed" => Self::Crashed,
            "pmsuspended" => Self::Suspended,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Vm {
    pub uuid: String,
    pub name: String,
    pub state: VmState,
    pub vcpus: u32,
    pub memory_kib: u64,
    pub autostart: bool,
    pub persistent: bool,
}

/// Une ligne `@@ <uuid>` puis la sortie de `virsh dominfo` pour chaque VM.
const INVENTORY: &str = "for u in $(VIRSH list --all --uuid); do echo \"@@ $u\"; VIRSH dominfo \"$u\"; done";

pub async fn list(conn: &Connection, access: Access, sudo: Option<&str>) -> Result<Vec<Vm>> {
    let script = INVENTORY.replace("VIRSH", VIRSH);
    let out = match access {
        Access::Direct => conn.exec(&script, None).await?,
        Access::Sudo => conn.exec_sudo(&script, sudo, None).await?,
        Access::Unavailable => return Err(Error::Other("libvirt n'est pas accessible sur ce serveur".into())),
    };
    let mut vms = parse_inventory(&out.into_result()?.stdout);
    vms.sort_by(|a, b| (a.state != VmState::Running).cmp(&(b.state != VmState::Running)).then(a.name.cmp(&b.name)));
    Ok(vms)
}

pub(crate) fn parse_inventory(text: &str) -> Vec<Vm> {
    let mut vms = Vec::new();
    for block in text.split("@@ ").skip(1) {
        let mut lines = block.lines();
        let uuid = lines.next().unwrap_or("").trim().to_string();
        if !valid_uuid(&uuid) {
            continue;
        }
        let mut vm = Vm { uuid, name: String::new(), state: VmState::Other, vcpus: 0, memory_kib: 0, autostart: false, persistent: false };
        for line in lines {
            let Some((key, value)) = line.split_once(':') else { continue };
            let value = value.trim();
            match key.trim() {
                "Name" => vm.name = value.to_string(),
                "State" => vm.state = VmState::parse(value),
                "CPU(s)" => vm.vcpus = value.parse().unwrap_or(0),
                "Max memory" => vm.memory_kib = value.trim_end_matches(" KiB").parse().unwrap_or(0),
                "Autostart" => vm.autostart = value == "enable",
                "Persistent" => vm.persistent = value == "yes",
                _ => {}
            }
        }
        vms.push(vm);
    }
    vms
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOMINFO: &str = include_str!("vm/fixtures/dominfo.txt");

    #[test]
    fn uuid_validation() {
        assert!(valid_uuid("11111111-2222-3333-4444-555555555555"));
        assert!(!valid_uuid("cirros-test"));
        assert!(!valid_uuid("11111111-2222-3333-4444-555555555555; reboot"));
    }

    #[test]
    fn inventory_includes_shut_off_vm() {
        let vms = parse_inventory(DOMINFO);
        let cirros = vms.iter().find(|v| v.name == "cirros-test").expect("cirros-test listée");
        assert_eq!(cirros.state, VmState::ShutOff);
        assert_eq!(cirros.vcpus, 1);
        assert_eq!(cirros.memory_kib, 131072);
        assert!(cirros.persistent);
    }

    #[test]
    fn vm_names_with_quotes() {
        let vms = parse_inventory(DOMINFO);
        let odd = vms.iter().find(|v| v.uuid == "11111111-2222-3333-4444-555555555555").unwrap();
        assert_eq!(odd.name, "l'été 2 \"test\"");
        assert!(odd.autostart);
        assert_eq!(odd.vcpus, 2);
    }

    #[test]
    fn states() {
        assert_eq!(VmState::parse("running"), VmState::Running);
        assert_eq!(VmState::parse("shut off"), VmState::ShutOff);
        assert_eq!(VmState::parse("paused"), VmState::Paused);
        assert_eq!(VmState::parse("in shutdown"), VmState::Shutdown);
        assert_eq!(VmState::parse("pmsuspended"), VmState::Suspended);
        assert_eq!(VmState::parse("crashed"), VmState::Crashed);
        assert_eq!(VmState::parse("???"), VmState::Other);
    }
}
