/** Erreur d'authentification du client SQL : c'est elle qui propose de saisir un compte. */
export const isAuthError = (message: string | null | undefined) =>
  !!message && /access denied|authentication failed|password authentication|no password supplied|Enter password/i.test(message);
