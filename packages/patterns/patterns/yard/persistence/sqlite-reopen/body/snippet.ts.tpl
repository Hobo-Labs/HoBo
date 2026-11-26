const again = openSelfHostedYard({ dataDir });
expect(again.readLog()).toEqual(first.readLog());
