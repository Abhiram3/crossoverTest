import express from "express";
import { WatchError, createClient } from "redis";
import { json } from "body-parser";

const DEFAULT_BALANCE = 1000;

interface ChargeResult {
    isAuthorized: boolean;
    remainingBalance: number;
    charges: number;
}

async function connect(): Promise<ReturnType<typeof createClient>> {
    const url = `redis://${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? "6379"}`;
    console.log(`Using redis URL ${url}`);
    const client = createClient({ url });
    await client.connect();
    return client;
}

async function reset(account: string): Promise<void> {
    const client = await connect();
    try {
        await client.set(`${account}/balance`, DEFAULT_BALANCE);
    } finally {
        await client.disconnect();
    }
}

async function charge(account: string, charges: number): Promise<ChargeResult> {
    const client = await connect();
    let isAuthorized = false;
    try {
        const remBalance = await client.executeIsolated(async isolatedClient => {
            await isolatedClient.watch(`${account}/balance`);

            const balance = parseInt((await isolatedClient.get(`${account}/balance`)) ?? "");

            if (balance >= charges) {
                isAuthorized = true;
                const multi = isolatedClient.multi()
                    .set(`${account}/balance`, balance - charges)
                    .get(`${account}/balance`);
                return multi.exec();
            } else {
                isAuthorized = false;
                // const multi = isolatedClient.multi()
                //     .get(`${account}/balance`);
                return [balance];
            }
        });
        const remBalanceIndex = isAuthorized ? 1 : 0;
        console.log('isAuthorized', isAuthorized);
        return {
            isAuthorized,
            remainingBalance: parseInt(remBalance[remBalanceIndex] as string ?? ""),
            charges: isAuthorized ? charges: 0
        };
    } catch(err) {
        const balance = parseInt((await client.get(`${account}/balance`)) ?? "");
        return { isAuthorized: false, remainingBalance: balance, charges: 0 };
    } finally {
        await client.disconnect();
    }
}

export function buildApp(): express.Application {
    const app = express();
    app.use(json());
    app.post("/reset", async (req, res) => {
        try {
            const account = req.body.account ?? "account";
            await reset(account);
            console.log(`Successfully reset account ${account}`);
            res.sendStatus(204);
        } catch (e) {
            console.error("Error while resetting account", e);
            res.status(500).json({ error: String(e) });
        }
    });
    app.post("/charge", async (req, res) => {
        try {
            const account = req.body.account ?? "account";
            const result = await charge(account, req.body.charges ?? 50);
            console.log(`Successfully charged account ${account}`);
            res.status(200).json(result);
        } catch (e) {
            console.error("Error while charging account", e);
            res.status(500).json({ error: String(e) });
        }
    });
    return app;
}
