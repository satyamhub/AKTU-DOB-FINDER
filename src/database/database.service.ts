import { MongoClient, Db } from 'mongodb';
import { MONGO_DB_URI } from '../config';
import { Student, SearchHistory } from '../interfaces';

let database: Db | null = null;
export const client = new MongoClient(MONGO_DB_URI); 

export class DatabaseService {
  static async connectToDatabase(): Promise<Db> {
    if (!database) {
      try {
        if (!process.env.DATABASE_NAME) {
          throw new Error('DATABASE_NAME is not set in environment variables');
        }
        await client.connect();
        database = client.db(process.env.DATABASE_NAME);
        await database.collection<Student>('students').createIndex(
          { applicationNumber: 1 },
          { unique: true }
        );
      } catch (error) {
        console.error('Error connecting to MongoDB:', error);
        throw error;
      }
    }
    return database;
  }
  static async findInDatabase(rollNumber: string): Promise<Student | null> {
    const db = await DatabaseService.connectToDatabase();
    const collection = db.collection<Student>('students'); 
    return collection.findOne({ applicationNumber: rollNumber });
  }

  static async saveToDatabase(data: Student): Promise<void> {
    const db = await DatabaseService.connectToDatabase();
    const collection = db.collection<Student>('students'); 
    await collection.updateOne(
      { applicationNumber: data.applicationNumber },
      { $set: data },
      { upsert: true }
    );
  }

  static async saveSearchHistory(record: SearchHistory): Promise<void> {
    const db = await DatabaseService.connectToDatabase();
    const collection = db.collection<SearchHistory>('search_history');
    await collection.insertOne(record);
  }

  static async listSearchHistory(limit = 20): Promise<SearchHistory[]> {
    const db = await DatabaseService.connectToDatabase();
    const collection = db.collection<SearchHistory>('search_history');
    return collection
      .find({})
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
  }
}
