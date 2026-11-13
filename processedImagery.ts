export interface GeographicImageBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const DATABASE_NAME = 'soldoc-geospatial-assets';
const STORE_NAME = 'processed-imagery';
const DATABASE_VERSION = 1;

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  if (!('indexedDB' in window)) {
    reject(new Error('This browser does not support local storage for processed imagery.'));
    return;
  }

  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Could not open processed imagery storage.'));
});

export const saveProcessedImagery = async (worldId: string, image: Blob) => {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(image, worldId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save processed imagery.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Saving processed imagery was cancelled.'));
    });
  } finally {
    database.close();
  }
};

export const loadProcessedImagery = async (worldId: string) => {
  const database = await openDatabase();
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(worldId);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error('Could not load processed imagery.'));
    });
  } finally {
    database.close();
  }
};

export const deleteProcessedImagery = async (worldId: string) => {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(worldId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete processed imagery.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Deleting processed imagery was cancelled.'));
    });
  } finally {
    database.close();
  }
};
