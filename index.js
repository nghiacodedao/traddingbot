const ccxt = require('ccxt');
const moment = require('moment');
const { EMA, RSI } = require('technicalindicators');
require('dotenv').config();

const ACCOUNT_BALANCE = 100; 
const RISK_PER_TRADE = 0.01; 
const STOP_LOSS_PERCENTAGE = 0.01; 
const TAKE_PROFIT_PERCENTAGE = 0.02; 

const TRADING_PAIRS = ['ETH/USDT', 'BTC/USDT'];

let currentPositions = {};
let openOrders = {};

const bitget = new ccxt.bitget({
    apiKey: process.env.BITGET_API_KEY,
    secret: process.env.BITGET_SECRET_KEY,
    password: process.env.BITGET_PASSWORD,
});

async function fetchPrices(symbol) {
    const prices = await bitget.fetchOHLCV(symbol, '1h');
    return prices.map(price => ({
        timestamp: moment(price[0]).format(),
        open: price[1],
        high: price[2],
        low: price[3],
        close: price[4],
        volume: price[5]
    }));
}

function calculateIndicators(prices) {
    const closingPrices = prices.map(p => p.close);
    return {
        ema34: EMA.calculate({ period: 34, values: closingPrices }),
        ema50: EMA.calculate({ period: 50, values: closingPrices }),
        ema150: EMA.calculate({ period: 150, values: closingPrices }),
        ema200: EMA.calculate({ period: 200, values: closingPrices }),
        rsi14: RSI.calculate({ period: 14, values: closingPrices })
    };
}

function addIndicators(prices, indicators) {
    return prices.map((price, index) => ({
        ...price,
        ema34: index >= 33 ? indicators.ema34[index - 33] : null,
        ema50: index >= 49 ? indicators.ema50[index - 49] : null,
        ema150: index >= 149 ? indicators.ema150[index - 149] : null,
        ema200: index >= 199 ? indicators.ema200[index - 199] : null,
        rsi14: index >= 13 ? indicators.rsi14[index - 13] : null
    }));
}

async function placeOrder(symbol, side, amount, entryPrice) {
    try {
        const order = await bitget.createMarketOrder(symbol, side, amount);
        console.log(`Order placed: ${side} ${amount} ${symbol}`, order);

        const stopLossPrice = side === 'buy' ? entryPrice * (1 - STOP_LOSS_PERCENTAGE) : entryPrice * (1 + STOP_LOSS_PERCENTAGE);
        const takeProfitPrice = side === 'buy' ? entryPrice * (1 + TAKE_PROFIT_PERCENTAGE) : entryPrice * (1 - TAKE_PROFIT_PERCENTAGE);

        await Promise.all([
            bitget.createOrder(symbol, 'stop', side === 'buy' ? 'sell' : 'buy', amount, stopLossPrice, { stopPrice: stopLossPrice }),
            bitget.createOrder(symbol, 'take_profit', side === 'buy' ? 'sell' : 'buy', amount, takeProfitPrice, { stopPrice: takeProfitPrice })
        ]);

        console.log(`Stop Loss at ${stopLossPrice} and Take Profit at ${takeProfitPrice}`);
        openOrders[symbol] = { side, amount, entryPrice, stopLossPrice, takeProfitPrice };
    } catch (error) {
        console.error(`Failed to place ${side} order for ${symbol}:`, error);
    }
}

async function manageOpenOrders(symbol) {
    try {
        const orders = await bitget.fetchOpenOrders(symbol);
        for (const order of orders) {
            const { price, side, id } = order;
            if (openOrders[symbol] && ((side === 'buy' && (price <= openOrders[symbol].stopLossPrice || price >= openOrders[symbol].takeProfitPrice)) ||
                (side === 'sell' && (price >= openOrders[symbol].stopLossPrice || price <= openOrders[symbol].takeProfitPrice)))) {
                console.log(`Order ${side} triggered at ${price} for ${symbol}`);
                await bitget.cancelOrder(id, symbol);
                console.log(`Order ${side} canceled at ${price} for ${symbol}`);
                currentPositions[symbol] = null;
                openOrders[symbol] = null;
            }
        }
    } catch (error) {
        console.error(`Failed to manage open orders for ${symbol}:`, error);
    }
}

function isBullishEngulfing(prev, curr) {
    return prev.close < prev.open && curr.close > curr.open && curr.close > prev.open && curr.open < prev.close;
}

function isBearishEngulfing(prev, curr) {
    return prev.close > prev.open && curr.close < curr.open && curr.close < prev.open && curr.open > prev.close;
}

async function analyzePair(symbol) {
    try {
        console.log(`Fetching prices for ${symbol}...`);
        const prices = await fetchPrices(symbol);
        console.log(`Fetched ${prices.length} price points for ${symbol}`);

        console.log(`Calculating indicators for ${symbol}...`);
        const indicators = calculateIndicators(prices);
        console.log(`Indicators calculated for ${symbol}`);

        console.log(`Adding indicators to prices for ${symbol}...`);
        const pricesWithIndicators = addIndicators(prices, indicators);
        console.log(`Indicators added to prices for ${symbol}`);

        for (let i = 1; i < pricesWithIndicators.length; i++) {
            const prev = pricesWithIndicators[i - 1];
            const curr = pricesWithIndicators[i];
            const tradeAmount = ACCOUNT_BALANCE * RISK_PER_TRADE;
            const amountToTrade = tradeAmount / curr.close;

            console.log(`Analyzing candlestick ${i}: ${curr.timestamp} for ${symbol}`);

            if (isBullishEngulfing(prev, curr) && curr.close > curr.ema34 && curr.rsi14 < 70 && currentPositions[symbol] !== 'buy') {
                console.log(`BUY Signal at ${curr.timestamp} for ${symbol}`);
                await placeOrder(symbol, 'buy', amountToTrade, curr.close);
                currentPositions[symbol] = 'buy';
            } else if (isBearishEngulfing(prev, curr) && curr.close < curr.ema34 && curr.rsi14 > 30 && currentPositions[symbol] !== 'sell') {
                console.log(`SELL Signal at ${curr.timestamp} for ${symbol}`);
                await placeOrder(symbol, 'sell', amountToTrade, curr.close);
                currentPositions[symbol] = 'sell';
            }

            if (curr.ema50 && prev.ema50) {
                if (prev.ema50 < prev.close && curr.ema50 > curr.close && curr.rsi14 < 70 && currentPositions[symbol] !== 'buy') {
                    console.log(`BUY Signal at ${curr.timestamp} (EMA50 Cross) for ${symbol}`);
                    await placeOrder(symbol, 'buy', amountToTrade, curr.close);
                    currentPositions[symbol] = 'buy';
                } else if (prev.ema50 > prev.close && curr.ema50 < curr.close && curr.rsi14 > 30 && currentPositions[symbol] !== 'sell') {
                    console.log(`SELL Signal at ${curr.timestamp} (EMA50 Cross) for ${symbol}`);
                    await placeOrder(symbol, 'sell', amountToTrade, curr.close);
                    currentPositions[symbol] = 'sell';
                }
            }
        }

        if (openOrders[symbol]) {
            console.log(`Managing open orders for ${symbol}...`);
            await manageOpenOrders(symbol);
        }
    } catch (error) {
        console.error(`Error in analyzePair function for ${symbol}:`, error);
    }
}

async function main() {
    for (const symbol of TRADING_PAIRS) {
        await analyzePair(symbol);
    }
}

async function checkAccountBalance() {
    try {
        const balance = await bitget.fetchBalance();
        console.log('Account balance:', balance.total);
    } catch (error) {
        console.error('Error fetching account balance:', error);
    }
}

async function runBot() {
    while (true) {
        await main();
        await new Promise(resolve => setTimeout(resolve, 60000)); // Đợi 1 phút trước khi chạy lại
    }
}

console.log('Starting bot on live account...');
checkAccountBalance().then(() => {
    runBot();
});
