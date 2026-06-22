import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import { getFirestore, doc, setDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBuRh3CZz5FSy4VzFQtInBKPoyyvgsg6to',
  authDomain: 'mvc-contract.firebaseapp.com',
  projectId: 'mvc-contract',
  storageBucket: 'mvc-contract.firebasestorage.app',
  messagingSenderId: '447659802675',
  appId: '1:447659802675:web:e6c1a5ca6ecc7945642346',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const CLIENT_ID = sessionStorage.getItem('fb_client_id') || (() => {
  const id = crypto.randomUUID();
  sessionStorage.setItem('fb_client_id', id);
  return id;
})();

let unsub = null;

export async function publishDashboard(serviceId, data) {
  await setDoc(doc(db, 'dashboard', String(serviceId)), {
    ...data,
    _sync: { clientId: CLIENT_ID, pushedAt: Date.now() },
  });
}

export function subscribeDashboard(serviceId, onUpdate) {
  if (unsub) unsub();
  unsub = onSnapshot(doc(db, 'dashboard', String(serviceId)), (snap) => {
    const val = snap.data();
    if (!val || !val.metrics) return;
    if (val._sync?.clientId === CLIENT_ID) return;
    const { _sync, ...rest } = val;
    onUpdate(rest);
  });
}

export function stopDashboardSubscribe() {
  if (unsub) { unsub(); unsub = null; }
}
