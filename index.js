const ccxt = require('ccxt');
const moment = require('moment');
const { EMA, RSI } = require('technicalindicators');
require('dotenv').config();

const ACCOUNT_BALANCE = 100; 
const RISK_PER_TRADE = 0.01; 
const STOP_LOSS_PERCENTAGE = 0.01; 
const TAKE_PROFIT_PERCENTAGE = 0.02; 

let currentPosition = null;
let openOrder = null;

const binance = new ccxt.binance({
    apiKey: process.env.,
    secret: process.env.
});

async function fetchPrices() {
    const prices = await binance.fetchOHLCV('ETH/USDT', '1h');
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

async function placeOrder(side, amount, entryPrice) {
    try {
        const order = await binance.createMarketOrder('ETH/USDT', side, amount);
        console.log(`Order placed: ${side} ${amount} ETH/USDT`, order);

        const stopLossPrice = side === 'buy' ? entryPrice * (1 - STOP_LOSS_PERCENTAGE) : entryPrice * (1 + STOP_LOSS_PERCENTAGE);
        const takeProfitPrice = side === 'buy' ? entryPrice * (1 + TAKE_PROFIT_PERCENTAGE) : entryPrice * (1 - TAKE_PROFIT_PERCENTAGE);

        await Promise.all([
            binance.createOrder('ETH/USDT', 'stop_loss_limit', side === 'buy' ? 'sell' : 'buy', amount, stopLossPrice, { stopPrice: stopLossPrice }),
            binance.createOrder('ETH/USDT', 'take_profit_limit', side === 'buy' ? 'sell' : 'buy', amount, takeProfitPrice, { stopPrice: takeProfitPrice })
        ]);

        console.log(`Stop Loss at ${stopLossPrice} and Take Profit at ${takeProfitPrice}`);
        openOrder = { side, amount, entryPrice, stopLossPrice, takeProfitPrice };
    } catch (error) {
        console.error(`Failed to place ${side} order:`, error);
    }
}

async function manageOpenOrders() {
    try {
        const orders = await binance.fetchOpenOrders('ETH/USDT');
        for (const order of orders) {
            const { price, side, id } = order;
            if (openOrder && ((side === 'buy' && (price <= openOrder.stopLossPrice || price >= openOrder.takeProfitPrice)) ||
                (side === 'sell' && (price >= openOrder.stopLossPrice || price <= openOrder.takeProfitPrice)))) {
                console.log(`Order ${side} triggered at ${price}`);
                await binance.cancelOrder(id, 'ETH/USDT');
                console.log(`Order ${side} canceled at ${price}`);
                currentPosition = null;
                openOrder = null;
            }
        }
    } catch (error) {
        console.error('Failed to manage open orders:', error);
    }
}

function isBullishEngulfing(prev, curr) {
    return prev.close < prev.open && curr.close > curr.open && curr.close > prev.open && curr.open < prev.close;
}

function isBearishEngulfing(prev, curr) {
    return prev.close > prev.open && curr.close < curr.open && curr.close < prev.open && curr.open > prev.close;
}

async function main() {
    try {
        const prices = await fetchPrices();
        const indicators = calculateIndicators(prices);
        const pricesWithIndicators = addIndicators(prices, indicators);

        for (let i = 1; i < pricesWithIndicators.length; i++) {
            const prev = pricesWithIndicators[i - 1];
            const curr = pricesWithIndicators[i];
            const tradeAmount = ACCOUNT_BALANCE * RISK_PER_TRADE;
            const amountToTrade = tradeAmount / curr.close;

            if (isBullishEngulfing(prev, curr) && curr.close > curr.ema34 && curr.rsi14 < 70 && currentPosition !== 'buy') {
                console.log(`BUY Signal at ${curr.timestamp}`);
                await placeOrder('buy', amountToTrade, curr.close);
                currentPosition = 'buy';
            } else if (isBearishEngulfing(prev, curr) && curr.close < curr.ema34 && curr.rsi14 > 30 && currentPosition !== 'sell') {
                console.log(`SELL Signal at ${curr.timestamp}`);
                await placeOrder('sell', amountToTrade, curr.close);
                currentPosition = 'sell';
            }

            if (curr.ema50 && prev.ema50) {
                if (prev.ema50 < prev.close && curr.ema50 > curr.close && curr.rsi14 < 70 && currentPosition !== 'buy') {
                    console.log(`BUY Signal at ${curr.timestamp} (EMA50 Cross)`);
                    await placeOrder('buy', amountToTrade, curr.close);
                    currentPosition = 'buy';
                } else if (prev.ema50 > prev.close && curr.ema50 < curr.close && curr.rsi14 > 30 && currentPosition !== 'sell') {
                    console.log(`SELL Signal at ${curr.timestamp} (EMA50 Cross)`);
                    await placeOrder('sell', amountToTrade, curr.close);
                    currentPosition = 'sell';
                }
            }
        }

        if (openOrder) await manageOpenOrders();
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
