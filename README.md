# Vérif 360

Petite application de bureau qui répond à une question : **la version 360° de cette vidéo YouTube est-elle téléchargeable ?** Si oui, elle la télécharge et, si besoin, la réencode pour qu'elle se lise sur un casque Meta Quest.

Usage personnel et test. Ne téléchargez que ce que l'auteur autorise : vidéo sous licence Creative Commons, ou accord de l'auteur. L'application affiche la licence de chaque vidéo.

## Télécharger l'application

Les versions prêtes à l'emploi sont dans les [Releases](https://github.com/Julien-Dr/video360-downloader/releases) :

| Système | Fichier |
|---|---|
| Mac Apple Silicon (M1 à M4) | `verif-360-…-mac-arm64.dmg` |
| Mac Intel | `verif-360-…-mac-x64.dmg` |
| Windows | `…-windows-installeur.exe`, ou `…-windows-portable.exe` sans installation |
| Linux | `…-linux-x86_64.AppImage` |

Les applications ne sont pas signées par un éditeur reconnu, d'où une étape au premier lancement :
- **Mac** : ouvrez le `.dmg` et glissez l'application dans Applications. Au premier lancement, si macOS bloque, allez dans **Réglages Système › Confidentialité et sécurité › Ouvrir quand même**. Si macOS la dit « endommagée », lancez `xattr -cr "/Applications/Verif 360.app"` dans le Terminal.
- **Windows** : SmartScreen affiche « Windows a protégé votre ordinateur » ; cliquez sur **Informations complémentaires › Exécuter quand même**.
- **Linux** : `chmod +x verif-360-*.AppImage`, puis lancez-le.

### Publier une nouvelle version

Changer `version` dans `package.json`, committer, puis pousser une étiquette :

```bash
git tag v1.0.1 && git push origin v1.0.1
```

L'action *Fabriquer l'application* construit les trois systèmes et crée la Release. On peut aussi la lancer à la main (onglet Actions › Run workflow) : les fichiers sont alors seulement dans les artefacts de l'exécution.

## Installation depuis le code (Mac)

Prérequis : Node.js (`brew install node`). ffmpeg via Homebrew est conseillé (`brew install ffmpeg`), car il encode avec la puce Apple, beaucoup plus vite. Sans lui, l'application utilise la copie de ffmpeg qu'elle embarque.

```bash
cd verif-360
npm install
npm start
```

Au premier lancement, cliquez sur **Installer yt-dlp** : l'application télécharge la version officielle depuis GitHub et la range dans son propre dossier. Si yt-dlp est déjà installé avec Homebrew, il est utilisé directement.

Pour fabriquer une vraie application (`.dmg`) : `npm run dist`, puis ouvrez le fichier du dossier `dist/`. L'application n'est pas signée par un développeur Apple : au premier lancement, faites clic droit › **Ouvrir**.

## Utilisation

1. Collez l'adresse de la vidéo, puis cliquez sur **Vérifier**.
2. Le verdict s'affiche :
   - **Oui** : un format équirectangulaire existe (image deux fois plus large que haute, par exemple 7680×3840). Un format carré est signalé comme probablement stéréo haut/bas.
   - **Cubemap EAC** : YouTube ne livre que sa projection interne en cube, que les lecteurs du Quest n'affichent pas correctement.
   - **Non** : seule une version à plat (16:9) est disponible.
3. Choisissez un format (le meilleur est présélectionné), le dossier, le suffixe (`_360`, `_360_TB`…), puis cliquez sur **Télécharger**.

### Ce que fait l'application pour vous

- **Astuce « user-agent vide »** : si aucune 360° n'est trouvée, l'application refait l'analyse avec cette astuce et la réutilise pour le téléchargement (réglable dans Options).
- **Réencodage H.265** : coché d'office quand le format choisi est en VP9 ou AV1, ou en H.264 au-delà de 4K. Sur Mac, il utilise l'encodeur matériel, avec x265 en secours. La largeur peut être limitée à 5,7K ou 4K.
- **Reprise** : un téléchargement annulé reprend là où il s'est arrêté quand on le relance.

### Lecteur 360°

Pour vérifier une vidéo avant de l'envoyer sur le casque :
- **Lire en 360°** à la fin d'un téléchargement ;
- bouton **Lecteur 360°** en haut de la fenêtre, pour ouvrir une vidéo de l'ordinateur ;
- ou glisser-déposer une vidéo sur la fenêtre.

On regarde autour en glissant à la souris ou avec les flèches. La molette ou les touches `+`/`-` zooment, `R` recentre la vue, `F` ou un double-clic passe en plein écran, `Espace` lance ou met en pause, `Échap` ferme le lecteur.

La projection est détectée d'après le suffixe du nom (`_360`, `_360_TB`, `_360_LR`, `_180_LR`, `_180`), sinon d'après les dimensions. Elle se change dans le menu en haut à droite. Pour les vidéos stéréo, seule la vue de l'œil gauche est affichée.

Le lecteur lit ce que lit Chromium : H.264, H.265 (avec le décodeur matériel du Mac), VP9 et AV1. Une vidéo 8K peut saccader sur l'ordinateur alors qu'elle passe très bien sur le casque.

### En cas de problème

- **« Prouvez que vous n'êtes pas un robot »** : dans Options, choisissez le navigateur où vous êtes connecté à YouTube (cookies).
- **Erreur 403 ou formats manquants** : cliquez sur la pastille *yt-dlp* en haut à droite pour le mettre à jour. YouTube change souvent son fonctionnement.

## Technique

- `src/main.js` : processus principal. Il lance yt-dlp et ffmpeg, et sert Electron comme moteur JavaScript à yt-dlp, ce qui évite d'installer Deno.
- `src/preload.js` : passerelle sécurisée entre la fenêtre et le processus principal.
- `renderer/` : interface (HTML, CSS, JS sans dépendance) ; `renderer/player.js` est le lecteur 360° (WebGL, shader équirectangulaire).
