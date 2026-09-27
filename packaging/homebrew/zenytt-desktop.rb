# Cask Homebrew de Zenytt.
#
# Régénéré par `python3 scripts/packaging.py vX.Y.Z` : la version et les deux empreintes viennent
# des assets de la release. À déposer dans un tap (`NathanChevrollier/homebrew-tap`), sous
# `Casks/zenytt-desktop.rb`, puis :
#
#     brew tap NathanChevrollier/tap
#     brew install --cask zenytt-desktop
cask "zenytt-desktop" do
  version "1.0.0"

  # Deux architectures, deux archives : Apple Silicon et Intel.
  on_arm do
    sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    url "https://github.com/NathanChevrollier/Zenytt/releases/download/v#{version}/Zenytt_#{version}_aarch64.dmg",
        verified: "github.com/NathanChevrollier/Zenytt/"
  end
  on_intel do
    sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    url "https://github.com/NathanChevrollier/Zenytt/releases/download/v#{version}/Zenytt_#{version}_x64.dmg",
        verified: "github.com/NathanChevrollier/Zenytt/"
  end

  name "Zenytt"
  desc "Manage, browse and monitor your servers over SSH"
  homepage "https://github.com/NathanChevrollier/Zenytt"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Zenytt.app"

  zap trash: [
    "~/Library/Application Support/dev.zenytt.desktop",
    "~/Library/Caches/dev.zenytt.desktop",
    "~/Library/Logs/dev.zenytt.desktop",
    "~/Library/Preferences/dev.zenytt.desktop.plist",
    "~/Library/Saved Application State/dev.zenytt.desktop.savedState",
  ]

  # Zenytt n'est pas encore notarisé par Apple : Gatekeeper refuse alors la première ouverture.
  # Le contournement est indiqué ici plutôt que caché dans le cask : c'est à l'utilisateur de
  # décider de faire confiance à une application non notarisée.
  caveats <<~CAVEATS
    Zenytt n'est pas encore notarisé par Apple. Si macOS refuse de l'ouvrir, autorise-le une fois :
      xattr -dr com.apple.quarantine "#{appdir}/Zenytt.app"

    Les mots de passe et phrases de passe de Zenytt sont conservés dans le trousseau macOS.
    `brew uninstall --zap` ne les supprime pas : retire-les depuis « Accès au trousseau »
    si tu ne veux plus en garder trace.
  CAVEATS
end
