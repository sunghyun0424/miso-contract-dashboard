'use strict';

const DB_NAME = 'miso-contract-dashboard';
const DB_VERSION = 1;
const ORDER_TTL_MS = 10 * 60 * 1000;

/** 주문 단위 FSM 상태 */
export const OrderState = {
  LISTED: 'listed',
  PAYMENT_OK: 'payment_ok',
  PAYMENT_NONE: 'payment_none',
  STALE: 'stale',
};

/** 세션 동기화 FSM */
export const SyncState = {
  IDLE: 'idle',
  HYDRATE: 'hydrate',
  CACHED: 'cached',
  FETCH: 'fetch',
  MERGE: 'merge',
  READY: 'ready',
  ERROR: 'error',
};

function orderFsmState(o) {
  if (o.state === OrderState.STALE) return OrderState.STALE;
  if (o.paymentAt) return OrderState.PAYMENT_OK;
  if (o.paymentFetched) return OrderState.PAYMENT_NONE;
  return OrderState.LISTED;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('orders')) {
        const store = db.createObjectStore('orders', { keyPath: 'id' });
        store.createIndex('serviceId', 'serviceId', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export class OrderStore {
  constructor(serviceId) {
    this.serviceId = String(serviceId);
    this.syncState = SyncState.IDLE;
    this.onStateChange = null;
  }

  setState(s) {
    this.syncState = s;
    if (this.onStateChange) this.onStateChange(s);
  }

  /** API 응답 orders → IDB upsert (FSM 전이) */
  async mergeOrders(orders) {
    this.setState(SyncState.MERGE);
    const db = await openDb();
    const now = Date.now();
    const tx = db.transaction(['orders', 'meta'], 'readwrite');
    const store = tx.objectStore('orders');
    for (const o of orders) {
      const row = {
        id: o.id,
        serviceId: this.serviceId,
        status: o.status,
        phone: o.phone || '',
        region: o.region || '',
        due_date: o.due_date || null,
        created_at: o.created_at || null,
        createdYmd: o.createdYmd || null,
        paymentAt: o.paymentAt || null,
        paymentYmd: o.paymentYmd || null,
        quotePrice: o.quotePrice ?? null,
        commissionFee: o.commissionFee ?? null,
        depositAmount: o.depositAmount ?? null,
        partnerPayout: o.partnerPayout ?? null,
        remainingBalance: o.remainingBalance ?? null,
        paymentFetched: o.paymentAt !== undefined,
        state: o.paymentAt ? OrderState.PAYMENT_OK : OrderState.PAYMENT_NONE,
        updatedAt: now,
      };
      store.put(row);
    }
    tx.objectStore('meta').put({
      key: 'service:' + this.serviceId,
      lastMergeAt: now,
      count: orders.length,
    });
    await txDone(tx);
    db.close();
    this.setState(SyncState.READY);
  }

  /** TTL 내 fresh 주문 로드 */
  async hydrateFresh() {
    this.setState(SyncState.HYDRATE);
    const db = await openDb();
    const minAt = Date.now() - ORDER_TTL_MS;
    const tx = db.transaction('orders', 'readonly');
    const idx = tx.objectStore('orders').index('serviceId');
    const req = idx.getAll(this.serviceId);
    const rows = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    const fresh = rows.filter((r) => r.updatedAt >= minAt && r.state !== OrderState.STALE);
    if (fresh.length) this.setState(SyncState.CACHED);
    else this.setState(SyncState.IDLE);
    return fresh.map((r) => ({
      id: r.id,
      status: r.status,
      phone: r.phone,
      region: r.region,
      due_date: r.due_date,
      created_at: r.created_at,
      createdYmd: r.createdYmd,
      paymentAt: r.paymentAt,
      paymentYmd: r.paymentYmd,
      quotePrice: r.quotePrice ?? null,
      commissionFee: r.commissionFee ?? null,
      depositAmount: r.depositAmount ?? null,
      partnerPayout: r.partnerPayout ?? null,
      remainingBalance: r.remainingBalance ?? null,
    }));
  }

  async clear() {
    const db = await openDb();
    const tx = db.transaction(['orders', 'meta'], 'readwrite');
    const idx = tx.objectStore('orders').index('serviceId');
    const req = idx.getAllKeys(this.serviceId);
    const keys = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
    const store = tx.objectStore('orders');
    for (const k of keys) store.delete(k);
    tx.objectStore('meta').delete('service:' + this.serviceId);
    await txDone(tx);
    db.close();
    this.setState(SyncState.IDLE);
  }
}

export { ORDER_TTL_MS, orderFsmState };
