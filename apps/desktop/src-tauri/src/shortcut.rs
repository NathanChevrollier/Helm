//! Raccourci du menu Démarrer (Windows).
//!
//! L'installateur ne crée aucun raccourci lors d'une mise à jour (il ne fait que mettre à jour ceux
//! qui existent). Une installation arrivée par la mise à jour de la version précédente de l'app,
//! dont les raccourcis ont disparu avec elle, n'en a donc aucun : Zenytt est alors introuvable dans
//! le menu Démarrer et la recherche Windows. Le raccourci est créé une seule fois : supprimé
//! ensuite volontairement, il n'est pas recréé.

// Tout ce module ne sert que sous Windows ; ailleurs, seuls ses tests l'utilisent.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};

/// Marqueur, dans le dossier de configuration : la vérification a déjà eu lieu sur ce poste.
const MARKER: &str = "raccourci-menu-demarrer";

/// Crée le raccourci et lui donne l'identifiant de l'app (AppUserModelID) : c'est lui qui relie
/// la fenêtre, l'épinglage dans la barre des tâches et les notifications au raccourci. Les chemins
/// arrivent par variables d'environnement, jamais dans le texte du script.
const SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:ZENYTT_LNK)
$s.TargetPath = $env:ZENYTT_EXE
$s.WorkingDirectory = Split-Path $env:ZENYTT_EXE
$s.IconLocation = "$($env:ZENYTT_EXE),0"
$s.Save()
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore { int GetCount(out uint c); int GetAt(uint i, out PropertyKey k); int GetValue(ref PropertyKey k, [Out] PropVariant v); int SetValue(ref PropertyKey k, [In] PropVariant v); int Commit(); }
[StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PropertyKey { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Sequential)] public class PropVariant { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public int p2; }
[ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPersistFile { int GetClassID(out Guid g); [PreserveSig] int IsDirty(); void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint m); void Save([MarshalAs(UnmanagedType.LPWStr)] string f, bool r); void SaveCompleted(string f); void GetCurFile(out IntPtr f); }
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink {}
public static class ZenyttAumid {
  public static void Set(string lnk, string id) {
    var link = new ShellLink(); var pf = (IPersistFile)link; pf.Load(lnk, 2);
    var store = (IPropertyStore)link;
    var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(id) };
    store.SetValue(ref key, v); store.Commit(); pf.Save(lnk, true);
    Marshal.FreeCoTaskMem(v.p);
  }
}
"@
[ZenyttAumid]::Set($env:ZENYTT_LNK, $env:ZENYTT_AUMID)
"#;

/// Script pour `-EncodedCommand` (UTF-16 LE en base64) : un script de plusieurs lignes avec des
/// guillemets ne passe pas intact en argument de ligne de commande.
pub(crate) fn encoded_script() -> String {
    use base64::Engine;
    let utf16: Vec<u8> = SCRIPT.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// L'exécutable est-il une installation (et non une compilation de développement) ?
pub(crate) fn is_installed(exe: &Path, local_app_data: &Path) -> bool {
    exe.starts_with(local_app_data) && !exe.components().any(|c| c.as_os_str() == "target")
}

/// Dossier des raccourcis du menu Démarrer de l'utilisateur.
fn start_menu() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(r"Microsoft\Windows\Start Menu\Programs"))
}

/// Crée le raccourci du menu Démarrer s'il manque, une seule fois par poste.
#[cfg(windows)]
pub fn ensure_start_menu_shortcut(config_dir: &Path, product: &str, identifier: &str) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let marker = config_dir.join(MARKER);
    let (Ok(exe), Some(local), Some(menu)) = (std::env::current_exe(), std::env::var_os("LOCALAPPDATA"), start_menu()) else { return };
    if marker.exists() || !is_installed(&exe, Path::new(&local)) {
        return;
    }
    let lnk = menu.join(format!("{product}.lnk"));
    if !lnk.exists() {
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded_script()])
            .env("ZENYTT_LNK", &lnk)
            .env("ZENYTT_EXE", &exe)
            .env("ZENYTT_AUMID", identifier)
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        match status {
            Ok(s) if s.success() => log::info!("raccourci du menu Démarrer créé : {}", lnk.display()),
            // Réessayé au prochain lancement : le marqueur n'est posé qu'une fois le raccourci en place.
            other => return log::warn!("raccourci du menu Démarrer impossible à créer : {other:?}"),
        }
    }
    let _ = std::fs::create_dir_all(config_dir);
    let _ = std::fs::write(&marker, b"");
}

#[cfg(not(windows))]
pub fn ensure_start_menu_shortcut(_config_dir: &Path, _product: &str, _identifier: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_is_encoded_as_utf16() {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded_script()).unwrap();
        let text = String::from_utf16(&bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()).unwrap();
        assert_eq!(text, SCRIPT);
    }

    #[test]
    fn only_installed_builds_get_a_shortcut() {
        let local = Path::new(r"C:\Users\a\AppData\Local");
        assert!(is_installed(Path::new(r"C:\Users\a\AppData\Local\Zenytt\zenytt-desktop.exe"), local));
        assert!(!is_installed(Path::new(r"C:\Users\a\Projets\zenytt\target\debug\zenytt-desktop.exe"), local));
        assert!(!is_installed(Path::new(r"C:\Users\a\AppData\Local\build\target\release\zenytt-desktop.exe"), local), "compilation locale");
    }
}
