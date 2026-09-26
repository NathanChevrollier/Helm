// Types minimaux de noVNC (le paquet n'en publie pas) : seulement ce que Helm utilise.
declare module "@novnc/novnc" {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RfbOptions {
    shared?: boolean;
    credentials?: RfbCredentials;
    wsProtocols?: string[];
    repeaterID?: string;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RfbOptions);
    /** Ajuste l'image à la zone d'affichage (sinon taille réelle, avec défilement). */
    scaleViewport: boolean;
    /** Demande au serveur d'adapter la résolution distante à la zone d'affichage. */
    resizeSession: boolean;
    clipViewport: boolean;
    /** N'envoie ni clavier ni souris : observation seule. */
    viewOnly: boolean;
    /** Qualité JPEG demandée au serveur, de 0 (légère) à 9 (sans perte visible). */
    qualityLevel: number;
    /** Compression demandée au serveur, de 0 (rapide) à 9 (compacte). */
    compressionLevel: number;
    showDotCursor: boolean;
    background: string;
    focusOnClick: boolean;
    sendCredentials(credentials: RfbCredentials): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
    focus(): void;
    blur(): void;
  }
}
