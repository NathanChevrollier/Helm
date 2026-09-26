# Cask Homebrew de Helm.
#
# Régénéré par `python3 scripts/packaging.py vX.Y.Z` : la version et les deux empreintes viennent
# des assets de la release. À déposer dans un tap (`NathanChevrollier/homebrew-tap`), sous
# `Casks/helm-desktop.rb`, puis :
#
#     brew tap NathanChevrollier/tap
#     brew install --cask helm-desktop
#
# Le cask s'appelle « helm-desktop » et non « helm » : ce dernier nom est déjà pris dans Homebrew
# par le gestionnaire de paquets Kubernetes.
cask "helm-desktop" do
  version "1.0.0"

  # Deux architectures, deux archives : Apple Silicon et Intel.
  on_arm do
    sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    url "https://github.com/NathanChevrollier/Helm/releases/download/v#{version}/Helm_#{version}_aarch64.dmg",
        verified: "github.com/NathanChevrollier/Helm/"
  end
  on_intel do
    sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    url "https://github.com/NathanChevrollier/Helm/releases/download/v#{version}/Helm_#{version}_x64.dmg",
        verified: "github.com/NathanChevrollier/Helm/"
  end

  name "Helm"
  desc "Manage, browse and monitor your servers over SSH"
  homepage "https://github.com/NathanChevrollier/Helm"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Helm.app"

  zap trash: [
    "~/Library/Application Support/dev.helm.desktop",
    "~/Library/Caches/dev.helm.desktop",
    "~/Library/Logs/dev.helm.desktop",
    "~/Library/Preferences/dev.helm.desktop.plist",
    "~/Library/Saved Application State/dev.helm.desktop.savedState",
  ]

  # Helm n'est pas encore notarisé par Apple : Gatekeeper refuse alors la première ouverture.
  # Le contournement est indiqué ici plutôt que caché dans le cask : c'est à l'utilisateur de
  # décider de faire confiance à une application non notarisée.
  caveats <<~CAVEATS
    Helm n'est pas encore notarisé par Apple. Si macOS refuse de l'ouvrir, autorise-le une fois :
      xattr -dr com.apple.quarantine "#{appdir}/Helm.app"

    Les mots de passe et phrases de passe de Helm sont conservés dans le trousseau macOS.
    `brew uninstall --zap` ne les supprime pas : retire-les depuis « Accès au trousseau »
    si tu ne veux plus en garder trace.
  CAVEATS
end
