# Stock App

Simple stock management web app with SQLite storage. Built for small shops to avoid paper-based tracking.

## Features

- Products with units and minimum stock
- Stock movements: receive, issue, adjust
- Low stock report
- CSV import/export
- User roles: admin and staff

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the server:

   ```bash
   npm start
   ```

3. Open the app:

   http://localhost:3000

## Default admin

- Username: admin
- Password: admin123

Create new users from the Users page after logging in.

## CSV import format

The CSV must include a header row with:

```
sku,name,unit,min_qty
```

Example:

```
sku,name,unit,min_qty
A001,Arabica beans,kg,5
A002,Milk,litre,10
```

## Data storage

The SQLite database is stored at:

```
./data/stock.db
```
