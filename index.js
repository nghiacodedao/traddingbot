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
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET_KEY,
    sandbox: true
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
        console.log('Fetching prices...');
        const prices = await fetchPrices();
        console.log(`Fetched ${prices.length} price points`);

        console.log('Calculating indicators...');
        const indicators = calculateIndicators(prices);
        console.log('Indicators calculated');

        console.log('Adding indicators to prices...');
        const pricesWithIndicators = addIndicators(prices, indicators);
        console.log('Indicators added to prices');

        for (let i = 1; i < pricesWithIndicators.length; i++) {
            const prev = pricesWithIndicators[i - 1];
            const curr = pricesWithIndicators[i];
            const tradeAmount = ACCOUNT_BALANCE * RISK_PER_TRADE;
            const amountToTrade = tradeAmount / curr.close;

            console.log(`Analyzing candlestick ${i}: ${curr.timestamp}`);

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

        if (openOrder) {
            console.log('Managing open orders...');
            await manageOpenOrders();
        }
    } catch (error) {
        console.error('Error in main function:', error);
    }
}

function testEngulfingPatterns() {
    const bullishTest = {
        prev: { open: 100, close: 98 },
        curr: { open: 97, close: 101 }
    };
    console.assert(isBullishEngulfing(bullishTest.prev, bullishTest.curr), 'Bullish engulfing test failed');

    const bearishTest = {
        prev: { open: 100, close: 102 },
        curr: { open: 103, close: 99 }
    };
    console.assert(isBearishEngulfing(bearishTest.prev, bearishTest.curr), 'Bearish engulfing test failed');

    console.log('Engulfing pattern tests completed');
}

async function checkAccountBalance() {
    try {
        const balance = await binance.fetchBalance();
        console.log('Account balance:', balance.total);
    } catch (error) {
        console.error('Error fetching account balance:', error);
    }
}

async function runBotTest(duration) {
    const startTime = Date.now();
    const endTime = startTime + duration;

    while (Date.now() < endTime) {
        await main();
        await new Promise(resolve => setTimeout(resolve, 60000));
    }

    console.log('Bot test completed');
    await checkAccountBalance();
}

async function runAllTests() {
    console.log('Starting tests...');
    
    testEngulfingPatterns();
    
    console.log('Checking initial account balance...');
    await checkAccountBalance();
    
    console.log('Running bot test for 10 minutes...');
    await runBotTest(600000);
    
    console.log('All tests completed.');
}

runAllTests();
