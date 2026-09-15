// Persistenza condivisa su Firebase: Authentication (accessi Titolare e Dipendente) + Firestore (dati).
// - I dati stanno in collezioni separate (vedi store.js): due tablet che lavorano insieme non si sovrascrivono.
// - Ogni salvataggio scrive solo i documenti cambiati; ogni altro dispositivo riceve le modifiche in tempo reale.
// - La cache locale di Firestore fa funzionare l'app anche senza rete: le scritture si allineano quando torna.
// - Le regole (firestore.rules) fanno rispettare i ruoli lato server; qui si evita solo di chiedere ciò che non è permesso.

import { initializeApp } from '../lib/firebase/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from '../lib/firebase/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, writeBatch, getDoc } from '../lib/firebase/firebase-firestore.js';
import { PuntiRipristino, ricomponi, canonico, differenze, COLLEZIONI, COLLEZIONI_TITOLARE, DOC_CONFIG, DOC_CONFIG_TITOLARE } from './store.js';

const MAX_BATCH = 450;   // limite Firestore: 500 operazioni per batch

export class FirebaseStore {
  condiviso = true;
  constructor(config, dominioAccessi) {
    this.dominio = dominioAccessi;
    this.app = initializeApp(config);
    this.auth = getAuth(this.app);
    this.db = initializeFirestore(this.app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    this.punti = new PuntiRipristino(5);
    this.utente = null;
    this.docs = {}; this.ultimo = {};      // collezione -> id -> dati / JSON canonico
    this.ascoltatori = []; this.suErrore = []; this.stop = [];
    this.caricato = false;
  }

  // ---------- accessi ----------
  /** Utente con sessione già salvata sul dispositivo, oppure null. */
  utenteCorrente() {
    return new Promise(res => {
      const off = onAuthStateChanged(this.auth, u => { off(); u ? this.profilo(u).then(res, () => res(null)) : res(null); });
    });
  }
  async profilo(u) {
    const snap = await getDoc(doc(this.db, 'utenti', u.uid));
    if (!snap.exists() || !['titolare', 'dipendente'].includes(snap.data().ruolo)) {
      await signOut(this.auth);
      throw Object.assign(new Error('accesso non configurato'), { code: 'profumari/senza-ruolo' });
    }
    this.utente = { uid: u.uid, email: u.email, ...snap.data() };
    return this.utente;
  }
  async accedi(nome, password) {
    const n = String(nome || '').trim().toLowerCase();
    const email = n.includes('@') ? n : `${n}@${this.dominio}`;
    const cred = await signInWithEmailAndPassword(this.auth, email, password);
    return this.profilo(cred.user);
  }
  async esci() {
    for (const s of this.stop) s();
    this.stop = []; this.docs = {}; this.ultimo = {}; this.caricato = false; this.utente = null;
    await signOut(this.auth);
  }
  get titolare() { return this.utente?.ruolo === 'titolare'; }
  collezioni() { return COLLEZIONI.filter(c => this.titolare || !COLLEZIONI_TITOLARE.has(c)); }
  docConfig() { return DOC_CONFIG.filter(id => this.titolare || !DOC_CONFIG_TITOLARE.has(id)); }

  // ---------- lettura in tempo reale ----------
  onChange(cb) { this.ascoltatori.push(cb); }
  onErrore(cb) { this.suErrore.push(cb); }
  statoAttuale() { return ricomponi(this.docs); }
  emetti() { const s = this.statoAttuale(); for (const cb of this.ascoltatori) cb(s); }

  /** Applica un documento arrivato dal server; ritorna true se è diverso da quello già noto (scrittura di un altro dispositivo). */
  applica(c, id, dati) {
    if (dati === undefined) {
      if (!(id in (this.docs[c] || {}))) return false;
      delete this.docs[c][id]; delete this.ultimo[c][id]; return true;
    }
    const j = canonico(dati);
    if (this.ultimo[c]?.[id] === j) return false;
    (this.docs[c] ??= {})[id] = dati; (this.ultimo[c] ??= {})[id] = j; return true;
  }

  async load() {
    if (!this.utente) throw new Error('nessun utente collegato');
    for (const c of COLLEZIONI) { this.docs[c] = {}; this.ultimo[c] = {}; }
    const attese = [];
    for (const c of this.collezioni()) {
      if (c === 'config') {
        for (const id of this.docConfig()) attese.push(new Promise((res, rej) => {
          let primo = false;
          this.stop.push(onSnapshot(doc(this.db, 'config', id), snap => {
            const cambiato = this.applica('config', id, snap.exists() ? snap.data() : undefined);
            if (!primo) { primo = true; res(); } else if (cambiato) this.emetti();
          }, err => { console.error('config', id, err); primo ? this.segnala(err) : rej(err); }));
        }));
        continue;
      }
      attese.push(new Promise((res, rej) => {
        let primo = false;
        this.stop.push(onSnapshot(collection(this.db, c), snap => {
          let cambiato = false;
          for (const ch of snap.docChanges()) cambiato = this.applica(c, ch.doc.id, ch.type === 'removed' ? undefined : ch.doc.data()) || cambiato;
          if (!primo) { primo = true; res(); } else if (cambiato) this.emetti();
        }, err => { console.error(c, err); primo ? this.segnala(err) : rej(err); }));
      }));
    }
    await Promise.all(attese);
    this.caricato = true;
    return this.statoAttuale();
  }
  segnala(err) { for (const cb of this.suErrore) cb(err); }

  // ---------- scrittura per differenze ----------
  save(stato, etichetta = '', conSnapshot = true) {
    if (!this.caricato) return false;
    if (conSnapshot && this.titolare) this.punti.conserva(JSON.stringify(this.statoAttuale()), etichetta);
    const ops = differenze(stato, this.ultimo, this.collezioni(), this.docConfig());
    for (const op of ops) {
      if (op.tipo === 'del') { delete this.docs[op.c][op.id]; delete this.ultimo[op.c][op.id]; }
      else { this.docs[op.c][op.id] = op.dati; this.ultimo[op.c][op.id] = op.json; }
    }
    for (let i = 0; i < ops.length; i += MAX_BATCH) {
      const b = writeBatch(this.db);
      for (const op of ops.slice(i, i + MAX_BATCH)) {
        const ref = doc(this.db, op.c, op.id);
        if (op.tipo === 'del') b.delete(ref); else b.set(ref, op.dati);
      }
      // Senza rete la promessa resta in sospeso finché la scrittura non viene confermata: non si aspetta.
      // Se il server rifiuta (regole), Firestore annulla la modifica locale e lo snapshot riporta i dati veri.
      b.commit().catch(err => { console.error('save', etichetta, err); this.segnala(err); });
    }
    return true;
  }
  snapshots() { return this.titolare ? this.punti.elenco() : []; }
  ripristina(indice) {
    const stato = this.punti.leggi(indice);
    if (!stato) return null;
    this.save(stato, 'prima del ripristino');
    return stato;
  }
}
