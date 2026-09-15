// Configurazione della versione condivisa (Firebase).
//
// I valori si copiano dalla console Firebase: Impostazioni progetto → Le tue app → app Web → "Configurazione".
// Non sono segreti: la protezione dei dati sta nelle regole di Firestore (firestore.rules) e negli accessi.
//
// Con FIREBASE_CONFIG = null l'app lavora in modalità locale: i dati restano nel browser del dispositivo (demo).
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAlHno59-AHd5xEEJFS50nEMH2IwjCaPGU',
  authDomain: 'profumari-magazzino.firebaseapp.com',
  projectId: 'profumari-magazzino',
  storageBucket: 'profumari-magazzino.firebasestorage.app',
  messagingSenderId: '790477759152',
  appId: '1:790477759152:web:c31b8a0fccf62b5d359175',
};

// Dominio aggiunto ai nomi di accesso senza chiocciola: "titolare" → titolare@iprofumari.it.
// Gli accessi si creano nella console Firebase (Authentication → Users) con lo stesso indirizzo.
export const DOMINIO_ACCESSI = 'iprofumari.it';

// Sulla demo pubblicata su GitHub Pages (e con ?demo nell'indirizzo) l'app resta in modalità locale
// anche se la configurazione è compilata: così main può contenere la configurazione senza toccare la demo.
export function modalitaCondivisa() {
  if (!FIREBASE_CONFIG) return false;
  try {
    if (new URLSearchParams(location.search).has('demo')) return false;
    if (location.hostname.endsWith('github.io')) return false;
  } catch { /* fuori dal browser */ }
  return true;
}
